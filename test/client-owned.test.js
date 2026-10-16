import {handle} from '../src/app.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runEngine} from '../src/engine.js';
import {MemoryStore} from '../src/store.js';
import {MODELS,modelOf} from '../src/core.js';
const env={V0_API_KEY:'fixture-only',V0_BASE_URL:'http://upstream.test/v2'};
async function fixture(run){
 const original=global.fetch,requests=[],store=new MemoryStore();
 global.fetch=async(url,options)=>{
  assert.equal(url,env.V0_BASE_URL+'/chats/stream');assert.equal(options.method,'POST');
  const payload=JSON.parse(options.body),index=requests.length+1;requests.push(payload);
  const usage={model:payload.modelConfiguration.modelId,tokens:{input:2,output:3},creditsCost:{total:0}};
  const items=[{object:'chat',id:'chat_'+index},{object:'message',id:'message_'+index,role:'assistant',parts:[{type:'text',text:JSON.stringify({type:'message',text:'answer_'+index})}],finishReason:'stop',usage}];
  return new Response(items.map(item=>'data: '+JSON.stringify(item)+String.fromCharCode(10,10)).join(''),{headers:{'Content-Type':'text/event-stream'}});
 };
 const generate=(body,extra={})=>runEngine({body,p:'responses',scope:'same-legacy-session',keyId:'main',store,env,signal:new AbortController().signal,...extra});
 try{await run({generate,requests,store});}finally{global.fetch=original;}
}
test('identical full-history requests produce independent chats and response identities',()=>fixture(async({generate,requests,store})=>{
 const body={model:'astra',input:'identical opening',store:false,prompt_cache_key:'same-cache'};
 const a=await generate(body),b=await generate(body);
 assert.notEqual(a.billing.chat_id,b.billing.chat_id);assert.notEqual(a.data.id,b.data.id);assert.equal(requests.length,2);
 assert.equal(store.data.size,0);assert.equal(store.locks.size,0);
}));
test('reset and summarized histories replace context rather than enforcing a prefix',()=>fixture(async({generate,requests})=>{
 await generate({model:'astra',instructions:'old rule',input:'private old context',store:false});
 await generate({model:'astra',instructions:'new rule',input:'Summary supplied by client',store:false});
 const prompt=JSON.parse(requests[1].message);
 assert.deepEqual(prompt.CLIENT_HISTORY,[{role:'user',content:'Summary supplied by client'}]);
 assert.deepEqual(prompt.CLIENT_SYSTEM_CONTEXT,[{role:'developer',content:'new rule'}]);
 assert(!requests[1].message.includes('private old context'));
}));
test('previous_response_id reconstructs history exactly once into a new upstream chat',()=>fixture(async({generate,requests})=>{
 const a=await generate({model:'astra',input:'first',instructions:'old instruction',store:true});
 const b=await generate({model:'astra',previous_response_id:a.data.id,input:'second',instructions:'new instruction',store:true});
 assert.notEqual(a.billing.chat_id,b.billing.chat_id);assert.equal(b.data.previous_response_id,a.data.id);
 const prompt=JSON.parse(requests[1].message);assert.equal(prompt.CLIENT_HISTORY.length,3);
 assert.equal(prompt.CLIENT_HISTORY[0].content,'first');assert.equal(prompt.CLIENT_HISTORY[2].content,'second');
 assert(!requests[1].message.includes('old instruction'));
 await assert.rejects(generate({model:'astra',previous_response_id:a.data.id,input:'cross-key'},{keyId:'other'}),error=>error.status===400);
 assert.equal(requests.length,2);
}));
test('store false and unknown references fail before any later generation',()=>fixture(async({generate,requests})=>{
 const a=await generate({model:'astra',input:'not retained',store:false});
 for(const id of [a.data.id,'resp_unknown'])await assert.rejects(generate({model:'astra',previous_response_id:id,input:'next'}),error=>error.status===400);
 assert.equal(requests.length,1);
}));
test('independent same-key requests run concurrently without a shared conversation lock',()=>fixture(async({generate,requests,store})=>{
 const responses=await Promise.all(Array.from({length:10},(_,index)=>generate({model:MODELS[index%MODELS.length],input:'conversation '+index,store:false})));
 assert.equal(new Set(responses.map(r=>r.billing.chat_id)).size,10);assert.equal(requests.length,10);assert.equal(store.locks.size,0);
 for(let index=0;index<responses.length;index++)assert.equal(responses[index].data.model,modelOf({model:MODELS[index%MODELS.length]}));
}));

const gatewayKey='client-owned-test-key-000000000000000';
function apiRequest(body,headers={}){return new Request('http://local/openai/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+gatewayKey,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});}
test('HTTP continuation resolves new lineage without consulting legacy sessions',()=>fixture(async({store,requests})=>{
 const config={...env,GATEWAY_API_KEY:gatewayKey};
 const first=await handle(apiRequest({model:'astra',input:'first'}),config,{store});
 assert.equal(first.status,200);const a=await first.json();
 const next=await handle(apiRequest({model:'astra',previous_response_id:a.id,input:'next'},{'X-V0-Session':'deprecated-value'}),config,{store});
 assert.equal(next.status,200);const b=await next.json();assert.notEqual(a.id,b.id);
 assert.equal(JSON.parse(requests[1].message).CLIENT_HISTORY.length,3);
}));
test('known preflight errors return HTTP errors rather than opening SSE',()=>fixture(async({store,requests})=>{
 const config={...env,GATEWAY_API_KEY:gatewayKey};
 for(const body of [
  {input:'next',previous_response_id:'resp_unknown'},
  {input:[{type:'compaction',encrypted_content:'opaque'}]},
  {input:'hello',store:'false'},
  {input:[{role:'user',content:[{type:'input_image',image_url:'https://example.invalid/image'}]}]}
 ]){
  const response=await handle(apiRequest({model:'astra',stream:true,...body}),config,{store});
  assert.equal(response.status,400);assert.match(response.headers.get('content-type'),/application\/json/);
 }
 const response=await handle(apiRequest({model:'astra',input:'hello',stream:true}),{GATEWAY_API_KEY:gatewayKey},{store});
 assert.equal(response.status,503);assert.equal(requests.length,0);assert.equal(store.usage.generations,0);
}));
test('legacy and native session hints cannot impose shared state on independent HTTP requests',()=>fixture(async({store,requests})=>{
 const config={...env,GATEWAY_API_KEY:gatewayKey};
 for(const input of ['first','reset summary']){
  const response=await handle(apiRequest({model:'astra',input,store:false},{'X-V0-Session':'same','thread-id':'one','session-id':'different'}),config,{store});
  assert.equal(response.status,200);
 }
 assert.equal(requests.length,2);assert.equal(store.data.size,0);
}));
