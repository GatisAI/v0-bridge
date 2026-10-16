import {BridgeError,hash,constantEqual,json,failure,readBody,integer,anthropicErrorType} from './util.js';
import {MODELS,validateRequest,normalizeTools} from './core.js';
import {storeFor} from './store.js';
import {resolveScope,runEngine} from './engine.js';
import {event,events} from './protocol.js';
import {readModels,modelRegistry,setupStatus}from'./config.js';
import {generateCandidate}from'./setup.js';
import {serveWeb}from'./web.js';
import {limits,measure} from './limits.js';

export async function authenticate(req,env){let keys;if(env.GATEWAY_KEYS_JSON){try{keys=JSON.parse(env.GATEWAY_KEYS_JSON);}catch{throw new BridgeError('Invalid GATEWAY_KEYS_JSON server config.',503);}if(!keys||typeof keys!=='object'||Array.isArray(keys)||!Object.keys(keys).length)throw new BridgeError('Invalid key mapping.',503);}else keys={main:env.GATEWAY_API_KEY};const bearer=req.headers.get('authorization');const value=bearer?.startsWith('Bearer ')?bearer.slice(7):req.headers.get('x-api-key')||'';const candidate=await hash(value);let found=null;for(const [id,key]of Object.entries(keys)){if(!/^[A-Za-z0-9_-]{1,64}$/.test(id)||typeof key!=='string'||key.length<24)throw new BridgeError('Configure strong gateway keys (min24 chars) with stable key IDs.',503);if(constantEqual(candidate,await hash(key)))found=id;}if(!found)throw new BridgeError('Invalid gateway API key.',401);return found;}
export function pathOf(req){const u=new URL(req.url);return u.searchParams.get('route')||u.pathname;}
const capability={experimental:true,billing:'v0_api_v2_NOT_ai_gateway',tools:'emulated_schema_validated',streaming:'buffered_with_heartbeat',native_effort_verified:false,token_limit:'soft_hint_not_hard_cap',sessions:'stable X-V0-Session strongly recommended; Redis durable state',unsupported:['images','compaction','native thinking signatures','sampling controls','full API parity']};
export async function handle(req,env=process.env,deps={}){let p='chat';try{
 const path=pathOf(req);if(path==='/v1/messages')p='anthropic';
 if(req.method==='GET'){const page=serveWeb(path);if(page)return page;}
 if(req.method==='GET'&&path==='/setup/status')return json(setupStatus(env));
 if(path==='/setup/generate-key'){if(req.method!=='POST')throw new BridgeError('Use POST.',405);return await generateCandidate(req,env);}
 if(req.method==='GET'&&path==='/health')return json({status:'ok',experimental:true});
 const keyId=await authenticate(req,env);
 if(req.method==='GET'&&path==='/v1/models')return json({object:'list',data:readModels(env).map(({id})=>({id,object:'model',created:0,owned_by:id.split('/')[0]}))});
 if(req.method==='GET'&&path==='/v1/bridge/capabilities')return json(capability);
 const routes={'/v1/chat/completions':'chat','/v1/responses':'responses','/codex/v1/responses':'responses','/v1/messages':'anthropic'};
 p=routes[path];if(!p)throw new BridgeError('Not found.',404);if(req.method!=='POST')throw new BridgeError('Use POST.',405);
 const config=limits(env);const body=await readBody(req,config.requestBytes,values=>measure('bridge_request_bytes',values));body._model_config=modelRegistry(env);const effort=validateRequest(body);normalizeTools(body,p);
 if(effort&&env.V0_EFFORT_MODE==='reject')throw new BridgeError('Explicit effort rejected: native control unverified.',400);
 const store=deps.store||storeFor(env);await store.rate(keyId);
 const scope=await resolveScope(body,p,req.headers.get('x-v0-session'),keyId,store);
 const headers={'X-V0-Bridge':'experimental; emulated-tools; buffered-stream; billing=v0','X-V0-Thinking-Control':'client-config-accepted-but-not-forwarded-native', 'X-V0-Effort-Mode':effort?'prompt_hint-not-native':'upstream-default','X-V0-Output-Token-Limit':'soft-only-not-enforced-by-upstream','Cache-Control':'no-store'};
 const aborter=new AbortController();const timeout=setTimeout(()=>aborter.abort(),config.deadlineSeconds*1000);
 const onAbort=()=>aborter.abort();req.signal.addEventListener('abort',onAbort,{once:true});
 if(req.signal.aborted)aborter.abort();
 const job=(deps.runEngine||runEngine)({body,p,scope,keyId,store,env,signal:aborter.signal});
 if(!body.stream){try{const r=await job;return json(r.data,200,{...headers,'X-V0-Chat-Id':r.billing.chat_id,'X-V0-Cache':r.billing.cached?'hit':'miss'});}finally{clearTimeout(timeout);req.signal.removeEventListener('abort',onAbort);}}
 const encoder=new TextEncoder();let ended=false;const stream=new ReadableStream({start(controller){const send=s=>{if(!ended)controller.enqueue(encoder.encode(s));};send(': buffered v0 bridge; waiting for upstream\n\n');const heartbeat=setInterval(()=>send(p==='anthropic'?event({type:'ping'},'ping'):': waiting\n\n'),8000);job.then(r=>{if(!ended)for(const s of events(r.data,p,body))send(s);}).catch(e=>{if(!ended)send(event(p==='anthropic'?{type:'error',error:{type:anthropicErrorType(e instanceof BridgeError?e.status:500),message:e instanceof BridgeError?e.message:'Bridge error'}}:{type:'error',error:{type:'bridge_error',message:e instanceof BridgeError?e.message:'Bridge error',code:e.status||500}},'error'));}).finally(()=>{clearInterval(heartbeat);clearTimeout(timeout);req.signal.removeEventListener('abort',onAbort);if(!ended){ended=true;controller.close();}});},cancel(){ended=true;aborter.abort();}});
 return new Response(stream,{headers:{...headers,'Content-Type':'text/event-stream; charset=utf-8','X-Accel-Buffering':'no'}});
 }catch(e){return failure(e,p==='anthropic'?'anthropic':'openai');}}
