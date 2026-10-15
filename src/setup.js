import {BridgeError,hash,constantEqual,json,readBody,randomToken} from './util.js';
// Best-effort per-instance rate limit. This endpoint ONLY makes INACTIVE random
// candidates; it never activates keys, reads secrets, edits env or spends v0 credits.
const buckets=new Map();
export async function generateCandidate(req,env){const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)throw new BridgeError('Cross-origin generation is not allowed.',403);if(req.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new BridgeError('Use application/json.',415);
 const now=Date.now(),ip=req.headers.get('x-vercel-forwarded-for')||req.headers.get('x-forwarded-for')||'local';
 const key=await hash(ip);let b=buckets.get(key);if(!b||now-b.start>60000)b={start:now,n:0};b.n++;buckets.set(key,b);if(buckets.size>1000){for(const [k,v]of buckets)if(now-v.start>60000)buckets.delete(k);if(buckets.size>1000)buckets.delete(buckets.keys().next().value);}if(b.n>10)throw new BridgeError('Too many generation attempts. Wait a minute.',429);
 const body=await readBody(req,4096);if(env.ADMIN_PIN){if(env.ADMIN_PIN.length<6||env.ADMIN_PIN.length>64)throw new BridgeError('ADMIN_PIN must be 6-64 characters.',503);if(typeof body.pin!=='string'||!constantEqual(await hash(body.pin),await hash(env.ADMIN_PIN)))throw new BridgeError('PIN salah.',401);}
 return json({key:randomToken('sk-v0-'),active:false,message:'Calon key saja. Tambahkan ke env Vercel lalu redeploy untuk mengaktifkan.'});}
