import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {BridgeError} from './util.js';
import {limits,measure} from './limits.js';
const zip=promisify(gzip),unzip=promisify(gunzip);
export async function encodeState(value,env={}){
 const config=limits(env),text=JSON.stringify(value),rawBytes=Buffer.byteLength(text);
 if(rawBytes>config.rawStateBytes){measure('bridge_state_bytes',{raw_bytes:rawBytes,limit_bytes:config.rawStateBytes,rejected:true});throw new BridgeError('State exceeds MAX_RAW_STATE_BYTES; start a new session with an explicit summary. Automatic context compaction is not enabled.',413);}
 const packed='gz:'+(await zip(text)).toString('base64');
 const stored=Buffer.byteLength(packed)<rawBytes?packed:text;const storedBytes=Buffer.byteLength(stored);
 measure('bridge_state_bytes',{raw_bytes:rawBytes,stored_bytes:storedBytes,limit_bytes:config.storedStateBytes,compressed:stored.startsWith('gz:'),rejected:storedBytes>config.storedStateBytes});
 if(storedBytes>config.storedStateBytes)throw new BridgeError('State exceeds MAX_STORED_STATE_BYTES after compression; start a new session with an explicit summary.',413);
 return stored;
}
export async function decodeState(stored,env={}){const config=limits(env);try{
 if(typeof stored!=='string'||Buffer.byteLength(stored)>config.storedStateBytes)throw Error();
 const text=stored.startsWith('gz:')?(await unzip(Buffer.from(stored.slice(3),'base64'),{maxOutputLength:config.rawStateBytes})).toString('utf8'):stored;
 if(Buffer.byteLength(text)>config.rawStateBytes)throw Error();
 measure('bridge_state_read_bytes',{stored_bytes:Buffer.byteLength(stored),raw_bytes:Buffer.byteLength(text)});return JSON.parse(text);
 }catch{throw new BridgeError('Stored state could not be decoded within configured limits. Inspect state and limits before retrying.',503);}}
export function commandBody(args,env={}){const body=JSON.stringify(args),bytes=Buffer.byteLength(body),max=limits(env).redisRequestBytes;if(bytes>max){measure('bridge_redis_request_bytes',{bytes,limit_bytes:max,rejected:true});throw new BridgeError('Redis command exceeds MAX_REDIS_REQUEST_BYTES including JSON overhead.',413);}return body;}
