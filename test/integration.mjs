// Requires a LOCAL Redis and the REST test adapter. Never contacts v0.
import assert from 'node:assert/strict';
import {RedisStore,RELEASE_LUA}from'../src/store.js';import {handle}from'../src/app.js';
const env={GATEWAY_API_KEY:'integration-key-000000000000000',UPSTASH_REDIS_REST_URL:process.env.TEST_REDIS_REST_URL||'http://127.0.0.1:6399',UPSTASH_REDIS_REST_TOKEN:process.env.TEST_REDIS_REST_TOKEN||'local-redis-test-token',STATE_NAMESPACE:'test-'+Date.now(),MAX_DAILY_GENERATIONS:'2',MAX_DAILY_REPORTED_COST:'1'};
const store=new RedisStore(env);await store.put('record',{persisted:true});assert.deepEqual(await new RedisStore(env).get('record'),{persisted:true});
const release=await store.lock('s');assert.equal(await store.command(['EVAL',RELEASE_LUA,1,store.key('lock:s'),'wrong-owner']),0);await assert.rejects(store.lock('s'),e=>e.status===409);await release();await(await store.lock('s'))();
const attempts=await Promise.allSettled(Array.from({length:10},()=>store.reserve()));assert.equal(attempts.filter(x=>x.status==='fulfilled').length,2);await store.charge(attempts.find(x=>x.status==='fulfilled').value,0.1);await assert.rejects(store.reserve(),e=>e.status===429);
const key=env.GATEWAY_API_KEY;const req=new Request('http://local/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','X-V0-Session':'integration'},body:JSON.stringify({model:'gpt-6-astra',input:'hello'})});
const original=global.fetch;let posts=0;const payloads=[];
global.fetch=async(url,opt)=>{
 if(String(url).startsWith('http://mock-v0')){
  assert.equal(new URL(url).pathname,'/chats/stream');assert.equal(opt.method,'POST');posts++;payloads.push(JSON.parse(opt.body));
  const items=[{object:'chat',id:'mock-chat-'+posts},{object:'message',id:'m'+posts,role:'assistant',finishReason:'stop',parts:[{type:'text',text:JSON.stringify({type:'message',text:'integration passed'})}],usage:{model:'openai/gpt-6-astra',tokens:{input:2,output:2},creditsCost:{total:0}}}];
  return new Response(items.map(item=>'data: '+JSON.stringify(item)+String.fromCharCode(10,10)).join(''));
 }
 return original(url,opt);
};
try{
 const liveEnv={...env,MAX_DAILY_GENERATIONS:'3',STATE_NAMESPACE:env.STATE_NAMESPACE+'-engine',V0_API_KEY:'not-real',V0_BASE_URL:'http://mock-v0'};
 const first=await handle(req.clone(),liveEnv);assert.equal(first.status,200);const a=await first.json();assert.equal(a.model,'gpt-6-astra');assert.equal(payloads[0].modelConfiguration.modelId,'openai/gpt-6-astra');
 const repeated=await handle(req.clone(),liveEnv);assert.equal(repeated.status,200);const b=await repeated.json();assert.notEqual(a.id,b.id);assert.equal(posts,2);
 const next=new Request(req.url,{method:'POST',headers:req.headers,body:JSON.stringify({model:'openai/gpt-6-astra',previous_response_id:a.id,input:'second'})});
 const nr=await handle(next,liveEnv);assert.equal(nr.status,200);const c=await nr.json();assert.equal(c.model,'gpt-6-astra');assert.equal(c.previous_response_id,a.id);assert.equal(posts,3);assert.equal(nr.headers.get('x-v0-chat-id'),'mock-chat-3');
 const history=JSON.parse(payloads[2].message).CLIENT_HISTORY;assert.equal(history.length,3);assert.equal(history[0].content,'hello');assert.equal(history[2].content,'second');
}finally{global.fetch=original;}
console.log('PASS: real Redis REST persistence, Lua lock ownership, durable generation safeguards, independent requests and response lineage across new store instances. Upstream mocked; no  spend.');
