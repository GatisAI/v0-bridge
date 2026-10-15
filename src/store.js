import { BridgeError, integer, randomToken } from './util.js';
import { gzipSync, gunzipSync } from 'node:zlib';

export const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

export const RESERVE_LUA = `
local n = tonumber(redis.call('HGET', KEYS[1], 'generations') or '0')
local c = tonumber(redis.call('HGET', KEYS[1], 'cost') or '0')

if n >= tonumber(ARGV[1]) or c >= tonumber(ARGV[2]) then
  return 0
end

redis.call('HINCRBY', KEYS[1], 'generations', 1)
redis.call('EXPIRE', KEYS[1], 172800)
return 1
`;

export const RATE_LUA = `
local n = redis.call('INCR', KEYS[1])

if n == 1 then
  redis.call('EXPIRE', KEYS[1], 60)
end

return n
`;

const MAX_RAW_STATE_BYTES = 8000000;
const MAX_STORED_STATE_BYTES = 950000;
const GZIP_PREFIX = 'gz:';

export class RedisStore {
  constructor(env) {
    this.env = env;
    this.prefix = env.STATE_NAMESPACE || 'v0bridge-production-v1';

    if (!/^[a-zA-Z0-9:_-]{1,100}$/.test(this.prefix)) {
      throw new BridgeError('Invalid STATE_NAMESPACE.', 503);
    }

    this.url = env.UPSTASH_REDIS_REST_URL;
    this.token = env.UPSTASH_REDIS_REST_TOKEN;
    this.ttl = integer(
      env.STATE_TTL_SECONDS,
      172800,
      3600,
      2592000
    );

    const validUrl =
      typeof this.url === 'string' &&
      (
        this.url.startsWith('https://') ||
        (
          !env.VERCEL &&
          env.NODE_ENV !== 'production' &&
          /^http:\/\/127\.0\.0\.1:\d+$/.test(this.url)
        )
      );

    if (!validUrl || !this.token) {
      throw new BridgeError(
        'Configure server-side Upstash Redis REST URL/token.',
        503
      );
    }
  }

  key(k) {
    return this.prefix + ':' + k;
  }

  async command(args) {
    let response;

    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + this.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new BridgeError(
        'State service unavailable; no blind upstream retry.',
        503
      );
    }

    if (!response.ok) {
      throw new BridgeError(
        'State service rejected request.',
        503
      );
    }

    let data;

    try {
      data = await response.json();
    } catch {
      throw new BridgeError(
        'Invalid state service response.',
        503
      );
    }

    if (data.error) {
      throw new BridgeError(
        'State service command failed.',
        503
      );
    }

    return data.result;
  }

  async get(k) {
    const stored = await this.command(['GET', this.key(k)]);

    if (stored == null) {
      return null;
    }

    try {
      // New records use gzip + base64.
      // Existing plain JSON records remain readable.
      const text = stored.startsWith(GZIP_PREFIX)
        ? gunzipSync(
            Buffer.from(
              stored.slice(GZIP_PREFIX.length),
              'base64'
            ),
            { maxOutputLength: MAX_RAW_STATE_BYTES }
          ).toString('utf8')
        : stored;

      return JSON.parse(text);
    } catch {
      throw new BridgeError(
        'Stored state could not be decoded. Inspect state before retrying.',
        503
      );
    }
  }

  async put(k, value) {
    const text = JSON.stringify(value);

    if (Buffer.byteLength(text, 'utf8') > MAX_RAW_STATE_BYTES) {
      throw new BridgeError(
        'Uncompressed state too large; start a new session.',
        413
      );
    }

    const packed =
      GZIP_PREFIX + gzipSync(text).toString('base64');

    if (
      Buffer.byteLength(packed, 'utf8') >
      MAX_STORED_STATE_BYTES
    ) {
      throw new BridgeError(
        'Compressed state too large; start a new session.',
        413
      );
    }

    await this.command([
      'SET',
      this.key(k),
      packed,
      'EX',
      this.ttl,
    ]);
  }

  async lock(k, ms = 280000) {
    const token = randomToken('lock_');

    const ok = await this.command([
      'SET',
      this.key('lock:' + k),
      token,
      'NX',
      'PX',
      ms,
    ]);

    if (ok !== 'OK') {
      throw new BridgeError(
        'This conversation already has an active request. Wait; do not send parallel turns.',
        409
      );
    }

    return async () => {
      await this.command([
        'EVAL',
        RELEASE_LUA,
        1,
        this.key('lock:' + k),
        token,
      ]);
    };
  }

  async reserve() {
    const day = new Date().toISOString().slice(0, 10);
    const k = this.key('usage:' + day);

    const ok = await this.command([
      'EVAL',
      RESERVE_LUA,
      1,
      k,
      integer(this.env.MAX_DAILY_GENERATIONS, 200),
      Number(this.env.MAX_DAILY_REPORTED_COST || 30),
    ]);

    if (!ok) {
      throw new BridgeError(
        'Daily bridge generation/reported-cost safeguard reached.',
        429
      );
    }

    return day;
  }

  async charge(day, cost) {
    if (!Number.isFinite(cost) || cost < 0) {
      return;
    }

    await this.command([
      'HINCRBYFLOAT',
      this.key('usage:' + day),
      'cost',
      String(cost),
    ]);
  }

  async rate(keyId) {
    const k = this.key(
      'rate:' + keyId + ':' + Math.floor(Date.now() / 60000)
    );

    const n = await this.command([
      'EVAL',
      RATE_LUA,
      1,
      k,
    ]);

    if (n > 60) {
      throw new BridgeError(
        'Shared key rate limit: 60 requests per minute.',
        429
      );
    }
  }
}

export class MemoryStore {
  constructor(env = {}) {
    this.env = env;
    this.data = new Map();
    this.locks = new Set();
    this.usage = {
      generations: 0,
      cost: 0,
    };
  }

  async get(k) {
    return structuredClone(this.data.get(k) || null);
  }

  async put(k, value) {
    this.data.set(k, structuredClone(value));
  }

  async lock(k) {
    if (this.locks.has(k)) {
      throw new BridgeError('Active session request.', 409);
    }

    this.locks.add(k);

    return async () => this.locks.delete(k);
  }

  async reserve() {
    const maxGenerations = Number(
      this.env.MAX_DAILY_GENERATIONS || 200
    );

    const maxCost = Number(
      this.env.MAX_DAILY_REPORTED_COST || 30
    );

    if (
      this.usage.generations >= maxGenerations ||
      this.usage.cost >= maxCost
    ) {
      throw new BridgeError('Daily safeguard reached.', 429);
    }

    this.usage.generations++;
    return 'local';
  }

  async charge(day, cost) {
    this.usage.cost += Number(cost) || 0;
  }

  async rate() {}
}

let memory;

export function storeFor(env) {
  if (env.STATE_BACKEND === 'memory') {
    if (env.VERCEL || env.NODE_ENV === 'production') {
      throw new BridgeError(
        'Memory state is forbidden in production. Configure Upstash.',
        503
      );
    }

    return memory ??= new MemoryStore(env);
  }

  return new RedisStore(env);
}
