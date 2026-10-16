import {BridgeError,hash,stable,sleep,clone} from './util.js';
import {modelOf,normalizeTools,normalizeConversation,canonicalEvent,validateEnvelope,validateRequest,BRIDGE_SYSTEM} from './core.js';
import {render} from './protocol.js';
import {limits,setting} from './limits.js';

export async function resolveScope(body,p,header,keyId,store){let scope;if(header){if(header.length>160||!/^[a-zA-Z0-9_.:-]+$/.test(header))throw new BridgeError('X-V0-Session: use 1-160 letters/digits/_.:-.',400);scope=await hash(stable([keyId,p,modelOf(body),header]));}
else if(p==='responses'&&body.previous_response_id){const link=await store.get('response-link:'+keyId+':'+body.previous_response_id);if(!link||link.model!==modelOf(body))throw new BridgeError('Unknown previous_response_id or model mismatch.',400);scope=link.scope;}
else{const {history}=normalizeConversation(body,p);const first=history.find(x=>x.role==='user')||history[0];scope=await hash(stable([keyId,p,modelOf(body),'auto:'+stable(canonicalEvent(first))]));}
return scope;}
async function v0json(env,method,path,body,signal){const base=env.V0_BASE_URL||'https://api.v0.dev/v2';if(!env.V0_API_KEY)throw new BridgeError('V0_API_KEY not configured.',503);if(env.VERCEL&&base!=='https://api.v0.dev/v2')throw new BridgeError('Production upstream URL override is disabled.',503);let r;try{r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+env.V0_API_KEY,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});}catch{throw new BridgeError('Upstream request failed or timed out. Work may exist; no automatic retry.',504);}if(!r.ok)throw new BridgeError(`v0 HTTP ${r.status}; upstream error body is not exposed. Inspect the v0 account/chat.`,r.status===429?429:502);try{return await r.json();}catch{throw new BridgeError('v0 response was not JSON.');}}

export async function runEngine({body,p,scope,keyId,store,env,signal}){
 const config=limits(env);const release=await store.lock(scope,(config.deadlineSeconds+30)*1000);let state=null;
 try{
  const old=await store.get('session:'+scope);
  if(old&&old.status!=='ok')throw new BridgeError('Session pending/failed. Inspect upstream chat; no blind retry or automatic new chat.',409);
  const previous=body.previous_response_id?await store.get('response:'+scope+':'+body.previous_response_id):null;
  const {system,history}=normalizeConversation(body,p,previous);const canonical=history.map(canonicalEvent);const tools=normalizeTools(body,p),effort=validateRequest(body);
  if(effort&&env.V0_EFFORT_MODE==='reject')throw new BridgeError('Native effort unverified; explicit effort rejected by server policy.',400);
  if(p==='anthropic'&&tools.some(x=>x.kind!=='function'))throw new BridgeError('Anthropic frontend requires function tools.',400);
  let choice=body.tool_choice??'auto';if(p==='anthropic'&&choice?.type==='auto')choice='auto';
  const signature=await hash(stable([canonical,system,tools,choice,effort,body.max_tokens,body.max_output_tokens,body.max_completion_tokens,body.parallel_tool_calls]));
  if(old?.signature===signature&&old.response)return {data:old.response,billing:{...old.billing,cached:true}};
  let offset=0;if(old){const h=old.history.map(canonicalEvent);if(canonical.length<h.length||stable(canonical.slice(0,h.length))!==stable(h))throw new BridgeError('History diverged. Use a NEW X-V0-Session for forks or cleared conversations.',409);offset=h.length;if(offset===canonical.length)throw new BridgeError('No new events. Start a new session for regeneration.',409);}
  if((old?.generations||0)>=setting(env,'MAX_SESSION_GENERATIONS',100,1,100000))throw new BridgeError('Session generation safeguard reached.',429);
  const delta=canonical.slice(offset),toolsHash=await hash(stable(tools)),systemHash=await hash(stable(system));
  let prompt=JSON.stringify({MODE:old?'continue_existing_client_session':'start_client_session',CLIENT_SYSTEM_CONTEXT:old?.systemHash===systemHash?'unchanged; retain context':system,AVAILABLE_TOOLS:old?.toolsHash===toolsHash?'unchanged; retain tools and schemas':tools,TOOL_CHOICE:choice,NEW_CLIENT_EVENTS:delta,EVENT_NOTE:'Previous assistant records acknowledge your prior JSON output. Only actual client tool results prove local actions. Do not repeat completed calls.',EFFORT_HINT_NOT_NATIVE_CONTROL:effort,REQUESTED_OUTPUT_LIMIT_SOFT_ONLY:body.max_output_tokens||body.max_completion_tokens||body.max_tokens,OUTPUT_RULE:(body.parallel_tool_calls===false?'At most ONE tool call.':'Independent calls may be batched. Dependent calls wait for tool results.')+' Return one bridge JSON envelope; never expose private reasoning.'});
  const pending={status:'pending',history:canonical,chat_id:old?.chat_id||null,toolsHash,systemHash,generations:old?.generations||0,updatedAt:new Date().toISOString()};
  await store.prepare('session:'+scope,pending);
  state=pending;
  let result,billing;
  for(let attempt=0;attempt<2;attempt++){
   if(signal.aborted)throw new BridgeError('Request cancelled before generation.',504);
   if(state.generations>=setting(env,'MAX_SESSION_GENERATIONS',100,1,100000))throw new BridgeError('Session generation safeguard reached, including envelope repair.',429);
   const day=await store.reserve();state.generations++;await store.put('session:'+scope,state);
   const payload={message:prompt,systemPrompt:BRIDGE_SYSTEM,modelConfiguration:{modelId:modelOf(body),imageGenerations:false},mcpServerIds:[]};
   const creating=!state.chat_id;if(creating)Object.assign(payload,{privacy:'private',title:`Node bridge ${p} ${scope.slice(0,8)}`,metadata:{bridge_session:scope,client_protocol:p}});
   const created=await v0json(env,'POST',creating?'/chats/async':`/chats/${state.chat_id}/messages/async`,payload,signal);
   state.chat_id=state.chat_id||created.chatId;state.message_id=created.messageId;if(!state.chat_id||!state.message_id)throw new BridgeError('Missing v0 chat/message IDs.');await store.put('session:'+scope,state);
   let msg;const until=Date.now()+Math.min(config.waitSeconds,config.deadlineSeconds)*1000;
   while(Date.now()<until&&!signal.aborted){msg=await v0json(env,'GET',`/chats/${state.chat_id}/messages/${state.message_id}`,null,signal);if(msg.finishReason!=null)break;await sleep(config.pollMs);}
   if(!msg||msg.finishReason==null)throw new BridgeError('Polling timeout. Generation may continue in v0; inspect chat before retry.',504);
   const usage=msg.usage||{},cost=Number(usage.creditsCost?.total||0);await store.charge(day,cost);
   billing={chat_id:state.chat_id,message_id:state.message_id,requested_model:modelOf(body),reported_model:usage.model,usage,part_types:(msg.parts||[]).map(x=>x.type),upstream_mode:creating?'create':'continue',new_client_events:delta.length,repair_attempt:attempt,effort_requested:effort,effort_mode:effort?'prompt_hint':'upstream_default',native_effort_verified:false,billing_source:'v0_api_v2',at:new Date().toISOString()};
   // Metadata only. Never log prompts, keys or tool payloads.
   console.log(JSON.stringify({event:'v0_usage',...billing}));
   if(usage.model!==modelOf(body))throw new BridgeError('Upstream model mismatch.');
   if(msg.finishReason!=='stop')throw new BridgeError('Upstream did not finish normally.');
   if((msg.parts||[]).some(x=>['bash','file-read','file-edit','tool-call'].includes(x.type)))throw new BridgeError('Internal v0 tools detected. No client call forwarded; inspect upstream.');
   const text=(msg.parts||[]).filter(x=>x.type==='text').map(x=>x.text||'').join('\n')||msg.content||'';
   try{result=validateEnvelope(text,tools,choice);if(body.parallel_tool_calls===false&&result.calls.length>1)throw new BridgeError('Multiple calls disallowed.');break;}catch(e){if(attempt||!(e instanceof BridgeError))throw e;prompt=JSON.stringify({ENVELOPE_REPAIR:e.message,INSTRUCTION:'Correct your JSON envelope only. Use offered tools/schema. Never run internal tools.'});}
  }
  const tokens=billing.usage.tokens||{},input=['input','cacheRead','cacheWrite'].reduce((s,k)=>s+(Number(tokens[k])||0),0),output=Number(tokens.output)||0;
  result={...result,model:modelOf(body),usage:{input_tokens:input,output_tokens:output,total_tokens:input+output},history,billing};
  const response=render(result,p,body);
  const completed={...state,status:'ok',signature,response,billing};
  await store.prepare('session:'+scope,completed);
  if(p==='responses'){
   await store.prepare('response:'+scope+':'+response.id,{model:result.model,history:[...clone(history),...clone(response.output)]});
   await store.put('response:'+scope+':'+response.id,{model:result.model,history:[...clone(history),...clone(response.output)]});
   await store.put('response-link:'+keyId+':'+response.id,{scope,model:result.model});
  }
  state=completed;await store.put('session:'+scope,state);return {data:response,billing};
 }catch(e){if(state){state.status='failed';state.error=e instanceof BridgeError?e.message:'Internal failure';await store.put('session:'+scope,state).catch(()=>{});}throw e;}
 finally{await release().catch(()=>{});}
}
