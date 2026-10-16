import {create} from 'jsondiffpatch';
import {BridgeError} from './util.js';
import {limits} from './limits.js';
import {setTimeout as delay} from 'node:timers/promises';

const patcher=create({});
const forbiddenKeys=new Set(['__proto__','prototype','constructor']);
function checkDelta(value,depth=0){
 if(depth>100)throw new BridgeError('Upstream delta nesting limit exceeded.');
 if(!value||typeof value!=='object')return;
 for(const [key,child] of Object.entries(value)){
  if(forbiddenKeys.has(key))throw new BridgeError('Unsafe upstream delta key.');
  checkDelta(child,depth+1);
 }
}
export function patchParts(parts,delta){
 checkDelta(delta);
 if(delta==null)return parts;
 const next=structuredClone(parts);
 try{
  if(Array.isArray(delta)&&delta[1]===9&&delta[2]===9){
   const path=delta[0];
   if(!Array.isArray(path)||path.length<2||typeof path.at(-1)!=='string')throw Error();
   let target=next;
   for(const index of path.slice(0,-1)){
    if(!Number.isSafeInteger(index)||index<0||!target||typeof target!=='object'||!Object.hasOwn(target,index))throw Error();
    if(typeof target[index]==='string'){target[index]+=path.at(-1);return next;}
    target=target[index];
   }
   throw Error();
  }
  const result=patcher.patch(next,delta);
  if(!Array.isArray(result))throw Error();
  return result;
 }catch{throw new BridgeError('Invalid upstream parts delta; partial output was not accepted.');}
}

export async function* readSse(body,signal,maxBytes=16000000){
 if(!body)throw new BridgeError('Upstream stream has no body.');
 const reader=body.getReader(),decoder=new TextDecoder();
 let pending='',data=[],size=0,ended=false;
 const cancel=()=>{void reader.cancel().catch(()=>{});};
 signal?.addEventListener('abort',cancel,{once:true});
 function line(text){
  if(text===''){const record=data.length?data.join('\n'):null;data=[];return record;}
  if(text.startsWith('data:'))data.push(text.slice(5).replace(/^ /,''));
  return null;
 }
 try{
  while(true){
   if(signal?.aborted)throw new BridgeError('Upstream stream cancelled.',504);
   const {value,done}=await reader.read();
   if(signal?.aborted)throw new BridgeError('Upstream stream cancelled.',504);
   if(done){ended=true;break;}
   size+=value.byteLength;
   if(size>maxBytes)throw new BridgeError('Upstream stream exceeds the response size limit.');
   pending+=decoder.decode(value,{stream:true});
   let index;
   while((index=pending.search(/[\r\n]/))!==-1){
    if(pending[index]==='\r'&&index===pending.length-1)break;
    const text=pending.slice(0,index);
    pending=pending.slice(index+(pending[index]==='\r'&&pending[index+1]==='\n'?2:1));
    const record=line(text);if(record!==null)yield record;
   }
  }
  pending+=decoder.decode();
  if(pending){const record=line(pending.replace(/[\r\n]+$/,''));if(record!==null)yield record;}
  if(data.length)yield data.join('\n');
 }finally{
  signal?.removeEventListener('abort',cancel);
  if(!ended)await reader.cancel().catch(()=>{});
  reader.releaseLock();
 }
}

function configuration(env){
 const base=env.V0_BASE_URL||'https://api.v0.dev/v2';
 if(!env.V0_API_KEY)throw new BridgeError('V0_API_KEY not configured.',503);
 if(env.VERCEL&&base!=='https://api.v0.dev/v2')throw new BridgeError('Production upstream URL override is disabled.',503);
 return {base,headers:{Authorization:'Bearer '+env.V0_API_KEY,'Content-Type':'application/json'}};
}
export async function createGeneration({env,payload,signal,onUpdate=()=>{},fetchImpl=fetch}){
 const {base,headers}=configuration(env);
 let chatId=null,messageId=null,message=null,parts=[],usage=null,finished=false,chatSnapshots=0;
 const httpError=async(response,stage)=>{
  let rateLimited=response.status===429;
  // v0 also returns HTTP403 for a JSON rate-limit denial. Classify only the
  // observed exact marker, not all 403s (which may really be permissions).
  if(response.status===403&&response.body){
   const reader=response.body.getReader(),chunks=[];let size=0;
   try{
    while(true){
     const {value,done}=await reader.read();if(done)break;
     size+=value.byteLength;if(size>4096)break;chunks.push(Buffer.from(value));
    }
    if(size<=4096){
     const error=JSON.parse(Buffer.concat(chunks).toString('utf8'));
     rateLimited=error?.message==='You are being rate limited. Please try again later.';
    }
   }catch{}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }else await response.body?.cancel().catch(()=>{});
  console.warn(JSON.stringify({event:'v0_upstream_http_error',stage,status:response.status,rate_limited:rateLimited,chat_id:chatId,message_id:messageId}));
  const message=rateLimited
   ?'Upstream rate limit (HTTP '+response.status+') during '+stage+'; retry later. No automatic generation retry.'
   :'Upstream HTTP '+response.status+' during '+stage+'; no automatic generation retry.';
  return new BridgeError(message,rateLimited?429:502);
 };
 const acceptMessage=event=>{
  if(typeof event.id!=='string'||!event.id||messageId&&messageId!==event.id)throw new BridgeError('Invalid upstream message identity.');
  if(event.chatId!=null&&event.chatId!==chatId)throw new BridgeError('Mismatched upstream message chat.');
  if(event.role!=='assistant'||!Array.isArray(event.parts))throw new BridgeError('Invalid upstream assistant message.');
  messageId=event.id;message=event;parts=event.parts;usage=event.usage??usage;finished=event.finishReason!=null;
 };
 const reconcile=async()=>{
  const config=limits(env),until=Date.now()+config.waitSeconds*1000;
  let reads=0;
  while(!finished){
   if(signal?.aborted)throw new BridgeError('Request cancelled during upstream reconciliation.',504);
   const remaining=until-Date.now();
   if(remaining<=0)throw new BridgeError('Upstream message still pending after stream close; no automatic generation retry.',504);
   const requestSignal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(Math.min(30000,remaining))]);
   const response=await fetchImpl(base+'/chats/'+encodeURIComponent(chatId)+'/messages/'+encodeURIComponent(messageId),{method:'GET',headers,signal:requestSignal,redirect:'error'});
   reads++;
   if(!response.ok){throw await httpError(response,'message_reconciliation');}
   let snapshot;try{snapshot=await response.json();}catch{throw new BridgeError('Upstream reconciliation returned invalid message JSON.');}
   if(!snapshot||typeof snapshot!=='object')throw new BridgeError('Invalid upstream reconciliation message.');
   acceptMessage(snapshot);
   if(!finished)await delay(Math.min(config.pollMs,Math.max(1,until-Date.now())),undefined,{signal});
  }
  console.log(JSON.stringify({event:'v0_stream_reconciled',chat_id:chatId,message_id:messageId,reads,finish_reason:message.finishReason}));
  await onUpdate({chatId,messageId,parts,usage,finished});
 };
 try{
  if(signal?.aborted)throw new BridgeError('Request cancelled before generation.',504);
  const response=await fetchImpl(base+'/chats/stream',{method:'POST',headers,body:JSON.stringify(payload),signal,redirect:'error'});
  if(!response.ok){throw await httpError(response,'create_stream');}
  for await(const record of readSse(response.body,signal)){
   if(record==='[DONE]')break;
   let event;try{event=JSON.parse(record);}catch{throw new BridgeError('Invalid upstream SSE JSON.');}
   if(!event||typeof event!=='object')throw new BridgeError('Invalid upstream SSE event.');
   if(event.object==='error')throw new BridgeError('Upstream generation failed; no automatic retry.');
   if(event.object==='chat'){
    if(typeof event.id!=='string'||!event.id||chatId&&chatId!==event.id)throw new BridgeError('Invalid upstream chat identity.');
    chatId=event.id;chatSnapshots++;
   }else if(event.object==='message'){
    if(event.role==='user')continue;
    acceptMessage(event);
   }else if(event.object==='message.parts.chunk'||event.object==='message.usage'){
    if(typeof event.id!=='string'||!event.id||messageId&&messageId!==event.id)throw new BridgeError('Mismatched upstream stream message.');
    messageId=event.id;
    if(event.object==='message.parts.chunk')parts=patchParts(parts,event.delta);
    else usage=event.usage;
   }else if(event.object!=='chat.title')throw new BridgeError('Unsupported upstream stream event.');
   await onUpdate({chatId,messageId,parts,usage,finished});
  }
  if(signal?.aborted)throw new BridgeError('Request cancelled.',504);
  // create-chat streams close with a chat snapshot, not necessarily a message.
  // Never infer success from that snapshot/usage alone: verify the actual message.
  if(chatId&&messageId&&!finished&&(chatSnapshots>=2||usage!=null))await reconcile();
  if(!chatId||!messageId||!finished)throw new BridgeError('Upstream stream ended without a terminal message; no automatic retry.');
  return {chatId,messageId,message:{...message,parts,usage}};
 }catch(error){
  if(chatId&&messageId&&!finished){
   try{
    const stopped=await fetchImpl(base+'/chats/'+encodeURIComponent(chatId)+'/messages/'+encodeURIComponent(messageId)+'/stop',{method:'POST',headers,signal:AbortSignal.timeout(5000),redirect:'error'});
    await stopped.body?.cancel().catch(()=>{});
   }catch{}
  }
  if(error instanceof BridgeError)throw error;
  throw new BridgeError('Upstream stream failed or timed out. Work may exist; no automatic retry.',504);
 }
}

