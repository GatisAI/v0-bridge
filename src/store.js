import {BridgeError,randomToken} from './util.js';
import {encodeState,decodeState,commandBody} from './state-codec.js';
import {setting,dailyCost} from './limits.js';
export const RELEASE_LUA=`if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`;
export const RESERVE_LUA=`local n=tonumber(redis.call('HGET',KEYS[1],'generations') or '0'); local c=tonumber(redis.call('HGET',KEYS[1],'cost') or '0'); if n>=tonumber(ARGV[1]) or c>=tonumber(ARGV[2]) then return 0 end; redis.call('HINCRBY',KEYS[1],'generations',1);redis.call('EXPIRE',KEYS[1],172800);return 1`;
export const RATE_LUA=`local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return n`;
export class RedisStore {
 constructor(env){this.env=env;this.prefix=env.STATE_NAMESPACE||'v0bridge-production-v1';if(!/^[a-zA-Z0-9:_-]{1,100}$/.test(this.prefix))throw new BridgeError('Invalid STATE_NAMESPACE.',503);this.url=env.UPSTASH_REDIS_REST_URL;this.token=env.UPSTASH_REDIS_REST_TOKEN;this.ttl=setting(env,'STATE_TTL_SECONDS',172800,3600,2592000);if(!this.url||!this.token||!(this.url.startsWith('https://')||(!env.VERCEL&&env.NODE_ENV!=='production'&&/^http:\/\/127\.0\.0\.1:\d+$/.test(this.url))))throw new BridgeError('Configure server-side Upstash Redis REST URL/token.',503);}
 key(k){return this.prefix+':'+k;}
 async command(args){const body=commandBody(args,this.env);let r;try{r=await fetch(this.url,{method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body,signal:AbortSignal.timeout(10000)});}catch{throw new BridgeError('State service unavailable; no blind upstream retry.',503);}if(!r.ok)throw new BridgeError('State service rejected request.',503);let x;try{x=await r.json();}catch{throw new BridgeError('Invalid state service response.',503);}if(x.error)throw new BridgeError('State service command failed.',503);return x.result;}
 async get(k){const x=await this.command(['GET',this.key(k)]);return x==null?null:decodeState(x,this.env);}
 async prepare(k,v){const packed=await encodeState(v,this.env);const args=['SET',this.key(k),packed,'EX',this.ttl];commandBody(args,this.env);return args;}
 async put(k,v){await this.command(await this.prepare(k,v));}
 async lock(k,ms=280000){const token=randomToken('lock_');const ok=await this.command(['SET',this.key('lock:'+k),token,'NX','PX',ms]);if(ok!=='OK')throw new BridgeError('This conversation already has an active request. Wait; do not send parallel turns.',409);return async()=>{await this.command(['EVAL',RELEASE_LUA,1,this.key('lock:'+k),token]);};}
 async reserve(){const day=new Date().toISOString().slice(0,10);const k=this.key('usage:'+day);const ok=await this.command(['EVAL',RESERVE_LUA,1,k,setting(this.env,'MAX_DAILY_GENERATIONS',200,1,100000),dailyCost(this.env)]);if(!ok)throw new BridgeError('Daily bridge generation/reported-cost safeguard reached.',429);return day;}
 async charge(day,cost){if(!Number.isFinite(cost)||cost<0)return;await this.command(['HINCRBYFLOAT',this.key('usage:'+day),'cost',String(cost)]);}
 async rate(keyId){const k=this.key('rate:'+keyId+':'+Math.floor(Date.now()/60000));const n=await this.command(['EVAL',RATE_LUA,1,k]);if(n>setting(this.env,'MAX_REQUESTS_PER_MINUTE',60,1,10000))throw new BridgeError('Shared key per-minute request limit reached.',429);}
}
export class MemoryStore {
 constructor(env={}){this.env=env;this.data=new Map();this.locks=new Set();this.usage={generations:0,cost:0};}
 async get(k){return structuredClone(this.data.get(k)||null);}
 async prepare(k,v){const packed=await encodeState(v,this.env);commandBody(['SET',k,packed,'EX',172800],this.env);}
 async put(k,v){await this.prepare(k,v);this.data.set(k,structuredClone(v));}
 async lock(k){if(this.locks.has(k))throw new BridgeError('Active session request.',409);this.locks.add(k);return async()=>this.locks.delete(k);}
 async reserve(){if(this.usage.generations>=setting(this.env,'MAX_DAILY_GENERATIONS',200,1,100000)||this.usage.cost>=dailyCost(this.env))throw new BridgeError('Daily safeguard reached.',429);this.usage.generations++;return 'local';}
 async charge(day,c){this.usage.cost+=Number(c)||0;}async rate(){}
}
let memory;
export function storeFor(env){if(env.STATE_BACKEND==='memory'){if(env.VERCEL||env.NODE_ENV==='production')throw new BridgeError('Memory state is forbidden in production. Configure Upstash.',503);return memory??=new MemoryStore(env);}return new RedisStore(env);}
