import test from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../src/app.js';
import {MemoryStore} from '../src/store.js';
const key='routing-test-key-000000000000000000';
const env={GATEWAY_API_KEY:key};
const headers={Authorization:'Bearer '+key,'Content-Type':'application/json'};
function deps(seen=[]){return {store:new MemoryStore(),runEngine:async args=>{seen.push(args.p);return {data:{id:'fixture-response'},billing:{chat_id:'fixture-chat'}};}};}
function request(path,auth=headers,body={model:'astra',input:'hello',messages:[{role:'user',content:'hello'}]}){return new Request('http://local'+path,{method:'POST',headers:auth,body:JSON.stringify(body)});}
test('canonical and legacy catalogs share the configured registry',async()=>{
 const config={...env,MODELS_JSON:JSON.stringify([{id:'test-model',upstreamId:'vendor/test-model',alias:'test',label:'Test'}])};
 for(const path of ['/openai/v1/models','/openai/v1/models/','/v1/models','/v1/models/']){
  const response=await handle(new Request('http://local'+path,{headers}),config);
  assert.equal(response.status,200,path);assert.deepEqual((await response.json()).data.map(x=>x.id),['test-model']);
 }
});
test('canonical and legacy generation routes dispatch internally including trailing slash',async()=>{
 const routes=[['/openai/v1/responses','responses'],['/openai/v1/chat/completions','chat'],['/anthropic/v1/messages','anthropic'],['/v1/responses','responses'],['/v1/chat/completions','chat'],['/v1/messages','anthropic'],['/codex/v1/responses','responses']];
 for(const [path,protocol]of routes)for(const suffix of ['', '/']){
  const seen=[],response=await handle(request(path+suffix),env,deps(seen));
  assert.equal(response.status,200,path+suffix);assert.deepEqual(seen,[protocol]);assert.equal(response.headers.get('location'),null);
 }
});
test('gateway accepts each supported authentication header and matching combinations',async()=>{
 for(const auth of [{Authorization:'Bearer '+key},{'api-key':key},{'x-api-key':key},{Authorization:'Bearer '+key,'api-key':key,'x-api-key':key}]){
  const response=await handle(new Request('http://local/v1/models',{headers:auth}),env);assert.equal(response.status,200);
 }
});
test('conflicting or malformed supplied credentials never silently select a valid header',async()=>{
 for(const auth of [{Authorization:'Bearer '+key,'api-key':'different'},{'x-api-key':key,'api-key':'different'},{Authorization:'Basic invalid','x-api-key':key},{Authorization:'Bearer '+key,'x-api-key':''}]){
  const response=await handle(request('/v1/responses',auth),env,deps());assert.equal(response.status,401);
 }
});
test('canonical Anthropic routes choose error format before auth including rewrites',async()=>{
 for(const path of ['/anthropic/v1/messages','/anthropic/v1/messages/','/api/gateway?route=/anthropic/v1/messages']){
  const response=await handle(request(path,{'api-key':'invalid'}),env);
  assert.equal(response.status,401);const body=await response.json();assert.equal(body.type,'error');assert.equal(body.error.type,'authentication_error');
 }
});