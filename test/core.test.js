import test from 'node:test';import assert from 'node:assert/strict';
import {modelOf,normalizeTools,normalizeConversation,canonicalEvent,validateEnvelope,validateRequest,MODELS} from '../src/core.js';
import {authenticate,handle} from '../src/app.js';import {MemoryStore}from'../src/store.js';import {responseKey,runEngine}from'../src/engine.js';import {events,render}from'../src/protocol.js';
const key='test-key-not-real-000000000000000000';const env={GATEWAY_API_KEY:key};const request=(path,body,k=key)=>new Request('http://local'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+k,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
const schema={type:'object',properties:{a:{type:'integer'}},required:['a'],additionalProperties:false};const tool={name:'add',kind:'function',schema};
test('model aliases and unknown models',()=>{assert.equal(modelOf({model:'astra'}),'gpt-6-astra');assert.throws(()=>modelOf({model:'fake'}));});
test('schema validation rejects unknown/malformed/forbidden tools',()=>{assert.equal(validateEnvelope('{"type":"tool_calls","calls":[{"name":"add","arguments":{"a":1}}]}',[tool],'auto').calls[0].arguments.a,1);for(const [v,choice]of [[{type:'tool_calls',calls:[{name:'other',arguments:{}}]},'auto'],[{type:'tool_calls',calls:[{name:'add',arguments:{a:'bad'}}]},'auto'],[{type:'message',text:'no'},'required'],[{type:'tool_calls',calls:[{name:'add',arguments:{a:1}}]},'none']])assert.throws(()=>validateEnvelope(JSON.stringify(v),[tool],choice));});
test('Codex custom tools + namespaces',()=>{const t=normalizeTools({input:[{type:'additional_tools',tools:[{type:'namespace',name:'functions',tools:[{type:'custom',name:'exec',format:{type:'text'}}]}]}]},'responses');assert.equal(t[0].name,'functions.exec');const r=validateEnvelope('{"type":"tool_calls","calls":[{"name":"functions.exec","input":"text(1)"}]}',t,'auto');assert.equal(r.calls[0].namespace,'functions');});
test('cache_control transport changes canonicalize; tool argument preserved',()=>{const a={role:'user',content:[{type:'tool_result',tool_use_id:'t',content:[{type:'text',text:'ok'}]}]};const b=structuredClone(a);b.content[0].cache_control={type:'ephemeral'};b.content[0].content[0].cache_control={type:'ephemeral'};assert.deepEqual(canonicalEvent(a),canonicalEvent(b));assert.match(canonicalEvent({role:'assistant',content:[{type:'tool_use',id:'t',name:'tool',input:{cache_control:'userdata'}}]}).content,/userdata/);b.content[0].content[0].text='changed';assert.notDeepEqual(canonicalEvent(a),canonicalEvent(b));});
test('unsupported controls fail explicitly; effort is accepted as hint',()=>{for(const b of [{min_tokens:1},{max_tokens:0},{max_output_tokens:-1},{temperature:0.5},{thinking:{type:'invalid'}},{stream:'yes'}])assert.throws(()=>validateRequest(b));for(const effort of ['none','minimal','low','medium','high','xhigh','max'])assert.equal(validateRequest({reasoning:{effort}}),effort);});
test('multikey identity is stable over rotation, invalid/removed keys rejected',async()=>{const req=request('/v1/models');assert.equal(await authenticate(req,env),'main');const mapping={GATEWAY_KEYS_JSON:JSON.stringify({main:key,other:'other-000000000000000000000000'})};assert.equal(await authenticate(req,mapping),'main');await assert.rejects(authenticate(request('/v1/models',null,'wrong'),mapping));const replacement='new-key-000000000000000000000000';assert.equal(await authenticate(request('/v1/models',null,replacement),{GATEWAY_KEYS_JSON:JSON.stringify({main:replacement})}),'main');await assert.rejects(authenticate(req,{GATEWAY_API_KEY:replacement}));});
test('public health/docs, model auth, static model list',async()=>{assert.equal((await handle(request('/health',null,'wrong'),env)).status,200);assert.equal((await handle(request('/v1/models',null,'wrong'),env)).status,401);const r=await handle(request('/v1/models'),env);assert.equal((await r.json()).data.length,4);});
test('response lineage keys isolate gateway identities',()=>{assert.notEqual(responseKey('main','resp_one'),responseKey('other','resp_one'));});
test('memory backend fails closed on Vercel',async()=>{const r=await handle(request('/v1/responses',{model:'astra',input:'hi'}),{...env,VERCEL:'1',STATE_BACKEND:'memory'});assert.equal(r.status,503);});
test('Responses event order, custom call naming, Anthropic event order',()=>{const base={model:MODELS[0],text:'hello',calls:[],usage:{input_tokens:2,output_tokens:1,total_tokens:3},billing:{}};const r=render(base,'responses',{});let es=[...events(r,'responses',{})].join('');assert.match(es,/response.created/);assert.match(es,/response.completed/);assert.match(es,/response.output_text.delta/);const c=render({...base,text:'',calls:[{kind:'custom',id:'call_1',name:'functions.exec',namespace:'functions',leaf_name:'exec',input:'text(1)'}]},'responses',{});assert.equal(c.output[0].name,'exec');assert.equal(c.output[0].namespace,'functions');const a=render(base,'anthropic',{});es=[...events(a,'anthropic',{})].join('');assert.match(es,/message_start/);assert.match(es,/message_stop/);});
test('full Chat history creates independent upstream chats without caching',async()=>{
 const store=new MemoryStore(),original=global.fetch,paths=[],payloads=[];let posts=0;
 global.fetch=async(url,options)=>{
  paths.push(new URL(url).pathname);assert.equal(options.method,'POST');posts++;payloads.push(JSON.parse(options.body));
  const items=[{object:'chat',id:'chat_'+posts},{object:'message',id:'message_'+posts,role:'assistant',finishReason:'stop',parts:[{type:'text',text:JSON.stringify({type:'message',text:'answer_'+posts})}],usage:{model:MODELS[0],tokens:{input:1,output:1},creditsCost:{total:0.1}}}];
  return new Response(items.map(item=>'data: '+JSON.stringify(item)+String.fromCharCode(10,10)).join(''));
 };
 try{
  const setup={p:'chat',keyId:'main',store,env:{...env,V0_API_KEY:'test',V0_BASE_URL:'http://upstream.test/v2'}};
  const body={model:'astra',messages:[{role:'user',content:'first'}]};
  const first=await runEngine({...setup,body});
  const next={...body,messages:[...body.messages,{role:'assistant',content:first.data.choices[0].message.content},{role:'user',content:'next'}]};
  const second=await runEngine({...setup,body:next}),repeated=await runEngine({...setup,body:next});
  assert.notEqual(first.billing.chat_id,second.billing.chat_id);assert.equal(second.billing.upstream_mode,'create');
  assert.notEqual(second.data.id,repeated.data.id);assert.equal(posts,3);
  assert.deepEqual(JSON.parse(payloads[1].message).CLIENT_HISTORY,next.messages);
  await runEngine({...setup,body:{...body,messages:[{role:'user',content:'fork'}]}});
  assert.equal(posts,4);assert(paths.every(path=>path==='/v2/chats/stream'));assert.equal(store.data.size,0);
 }finally{global.fetch=original;}
});
test('memory lock rejects concurrent request and releases',async()=>{const s=new MemoryStore();const release=await s.lock('x');await assert.rejects(s.lock('x'),e=>e.status===409);await release();await(await s.lock('x'))();});
test('daily generation safeguard',async()=>{const s=new MemoryStore({MAX_DAILY_GENERATIONS:'1'});await s.reserve();await assert.rejects(s.reserve(),e=>e.status===429);});
test('thinking config accepted only for compatibility; native control not claimed',()=>{for(const type of ['enabled','adaptive','disabled'])assert.equal(validateRequest({thinking:{type}}),null);});
test('text-only rejects image content',()=>{assert.throws(()=>normalizeConversation({messages:[{role:'user',content:[{type:'image_url',image_url:{url:'x'}}]}]},'chat'));});
