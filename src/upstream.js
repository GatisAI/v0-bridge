import {create} from 'jsondiffpatch';
import {BridgeError} from './util.js';

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
 let chatId=null,messageId=null,message=null,parts=[],usage=null,finished=false;
 try{
  if(signal?.aborted)throw new BridgeError('Request cancelled before generation.',504);
  const response=await fetchImpl(base+'/chats/stream',{method:'POST',headers,body:JSON.stringify(payload),signal,redirect:'error'});
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new BridgeError(' HTTP '+response.status+'; upstream error body is not exposed.',response.status===429?429:502);}
  for await(const record of readSse(response.body,signal)){
   if(record==='[DONE]')break;
   let event;try{event=JSON.parse(record);}catch{throw new BridgeError('Invalid upstream SSE JSON.');}
   if(!event||typeof event!=='object')throw new BridgeError('Invalid upstream SSE event.');
   if(event.object==='error')throw new BridgeError('Upstream generation failed; no automatic retry.');
   if(event.object==='chat'){
    if(typeof event.id!=='string'||!event.id||chatId&&chatId!==event.id)throw new BridgeError('Invalid upstream chat identity.');
    chatId=event.id;
   }else if(event.object==='message'){
    if(event.role==='user')continue;
    if(typeof event.id!=='string'||!event.id||messageId&&messageId!==event.id)throw new BridgeError('Invalid upstream message identity.');
    messageId=event.id;message=event;
    if(!Array.isArray(event.parts))throw new BridgeError('Invalid upstream message parts.');
    parts=event.parts;usage=event.usage??usage;
    finished=event.finishReason!=null;
   }else if(event.object==='message.parts.chunk'||event.object==='message.usage'){
    if(typeof event.id!=='string'||!event.id||messageId&&messageId!==event.id)throw new BridgeError('Mismatched upstream stream message.');
    messageId=event.id;
    if(event.object==='message.parts.chunk')parts=patchParts(parts,event.delta);
    else usage=event.usage;
   }else if(event.object!=='chat.title')throw new BridgeError('Unsupported upstream stream event.');
   await onUpdate({chatId,messageId,parts,usage,finished});
  }
  if(signal?.aborted)throw new BridgeError('Request cancelled.',504);
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

