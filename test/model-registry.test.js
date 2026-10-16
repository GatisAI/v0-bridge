import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_MODELS,readModels,modelRegistry} from '../src/config.js';
import {modelEntry,modelOf} from '../src/core.js';
import {validateModels} from '../public/assets/env.js';
import {handle} from '../src/app.js';
import {MemoryStore} from '../src/store.js';
import {responseKey} from '../src/engine.js';
const key='model-test-key-000000000000000000',env={GATEWAY_API_KEY:key,V0_API_KEY:'fixture',V0_BASE_URL:'http://upstream.test/v2'};
const headers={Authorization:'Bearer '+key,'Content-Type':'application/json'};
const request=(path,body)=>new Request('http://local'+path,{method:'POST',headers,body:JSON.stringify(body)});
async function fixture(run){
 const original=global.fetch,seen=[],store=new MemoryStore();let reported;
 global.fetch=async(url,options)=>{
  assert.equal(url,env.V0_BASE_URL+'/chats/stream');const payload=JSON.parse(options.body);seen.push(payload);
  const items=[{object:'chat',id:'chat_'+seen.length},{object:'message',id:'m_'+seen.length,role:'assistant',finishReason:'stop',parts:[{type:'text',text:JSON.stringify({type:'message',text:'ok'})}],usage:{model:reported??payload.modelConfiguration.modelId,tokens:{input:1,output:1},creditsCost:{total:0}}}];
  return new Response(items.map(item=>'data: '+JSON.stringify(item)+'\n\n').join(''));
 };
 try{await run({store,seen,setReported:value=>{reported=value;}});}finally{global.fetch=original;}
}
test('explicit built-in mappings preserve exact upstream IDs and canonical public names',()=>{
 assert.deepEqual(DEFAULT_MODELS.map(m=>[m.id,m.upstreamId]),[['gpt-6-astra','openai/gpt-6-astra'],['claude-fable-5.1','anthropic/claude-fable-5.1'],['claude-opus-5.5','anthropic/claude-opus-5.5'],['gpt-6.1-sol','openai/gpt-6.1-sol']]);
 for(const m of DEFAULT_MODELS)for(const name of [m.id,m.upstreamId,m.alias]){assert.equal(modelOf({model:name}),m.id);assert.equal(modelEntry({model:name}).upstreamId,m.upstreamId);}
 for(const name of ['',null,42,'toString','unknown/model','gpt-unknown'])assert.throws(()=>modelOf({model:name}),e=>e.status===400);
});
test('old built-in object/string env migrates identically in server and browser',()=>{
 for(const list of [DEFAULT_MODELS.map(({upstreamId,alias,label})=>({id:upstreamId,alias,label})),DEFAULT_MODELS.map(m=>m.upstreamId),DEFAULT_MODELS.map(m=>m.id)]){
  const raw=JSON.stringify(list);assert.deepEqual(readModels({MODELS_JSON:raw}),validateModels(raw));assert.deepEqual(readModels({MODELS_JSON:raw}),DEFAULT_MODELS);
 }
});
test('custom mapping is explicit and legacy aliases remain accepted',()=>{
 for(const item of [{id:'custom',upstreamId:'vendor/exact-model',alias:'short',aliases:['old-name']},{id:'vendor/exact-model',publicId:'custom',alias:'short',aliases:['old-name']}]){
  const registry=modelRegistry({MODELS_JSON:JSON.stringify([item])});
  for(const name of ['custom','vendor/exact-model','short','old-name'])assert.equal(modelEntry({model:name,_model_config:registry}).upstreamId,'vendor/exact-model');
 }
});
test('duplicate and ambiguous registry entries fail closed without prefix guessing',()=>{
 const a={id:'one',upstreamId:'vendor/one',alias:'first'};
 const bad=[[a,a],[a,{id:'first',upstreamId:'vendor/two'}],[a,{id:'two',upstreamId:'vendor/two',alias:'vendor/one'}],[a,{id:'two',upstreamId:'vendor/one'}],[{...a,aliases:['first']}],[{...a,alias:'astra'}],[{id:'gpt-6-astra',upstreamId:'vendor/wrong'}],[{id:'openai/gpt-6-astra',upstreamId:'vendor/wrong'}],['vendor/unknown'],[{id:'custom'}]];
 for(const list of bad){const raw=JSON.stringify(list);assert.throws(()=>readModels({MODELS_JSON:raw}),e=>e.status===503);assert.throws(()=>validateModels(raw));}
});
test('all catalog aliases expose public IDs even with old env',async()=>{
 const config={...env,MODELS_JSON:JSON.stringify(DEFAULT_MODELS.map(m=>m.upstreamId))};
 for(const path of ['/openai/v1/models','/openai/v1/models/','/v1/models','/api/gateway?route=/openai/v1/models']){
  const response=await handle(new Request('http://local'+path,{headers}),config);assert.equal(response.status,200);
  const data=(await response.json()).data;assert.deepEqual(data.map(m=>m.id),DEFAULT_MODELS.map(m=>m.id));assert.equal(data[0].owned_by,'openai');
 }
});
test('all adapters map public and legacy names upstream and return public model in JSON and SSE',()=>fixture(async({store,seen})=>{
 for(const path of ['/openai/v1/chat/completions','/openai/v1/responses','/anthropic/v1/messages','/v1/chat/completions','/v1/responses','/v1/messages'])for(const m of DEFAULT_MODELS)for(const name of [m.id,m.upstreamId,m.alias])for(const stream of [false,true]){
  const response=await handle(request(path,{model:name,input:'hello',messages:[{role:'user',content:'hello'}],store:false,stream}),env,{store});
  assert.equal(response.status,200);assert.equal(seen.at(-1).modelConfiguration.modelId,m.upstreamId);
  if(!stream)assert.equal((await response.json()).model,m.id);
  else{const events=(await response.text()).split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));const models=events.map(e=>e.model??e.response?.model??e.message?.model).filter(Boolean);assert(models.length>0);assert(models.every(id=>id===m.id));}
 }
}));
test('lineage normalizes aliases and preserves old upstream-named response records',()=>fixture(async({store,seen})=>{
 const m=DEFAULT_MODELS[0],path='/openai/v1/responses';
 const first=await handle(request(path,{model:m.upstreamId,input:'first'}),env,{store});const a=await first.json();assert.equal(a.model,m.id);
 const record=await store.get(responseKey('main',a.id));assert.equal(record.upstreamId,m.upstreamId);
 for(const model of [m.id,m.upstreamId,m.alias]){const r=await handle(request(path,{model,previous_response_id:a.id,input:'next'}),env,{store});assert.equal(r.status,200);assert.equal((await r.json()).model,m.id);}
 await store.put(responseKey('main','resp_legacy_name'),{version:2,model:m.upstreamId,history:[{role:'user',content:'old'}]});
 const r=await handle(request(path,{model:m.id,previous_response_id:'resp_legacy_name',input:'next'}),env,{store});assert.equal(r.status,200);assert.equal((await r.json()).model,m.id);
 const count=seen.length;const mismatch=await handle(request(path,{model:DEFAULT_MODELS[1].id,previous_response_id:a.id,input:'next'}),env,{store});assert.equal(mismatch.status,400);assert.equal(seen.length,count);
}));
test('wrong reported upstream or unknown requested model never falls back',()=>fixture(async({store,seen,setReported})=>{
 setReported('gpt-6-astra');const r=await handle(request('/v1/responses',{model:'gpt-6-astra',input:'hello'}),env,{store});assert.equal(r.status,502);assert.equal(seen.length,1);assert.equal(store.data.size,0);
 const bad=await handle(request('/v1/responses',{model:'unknown-model',input:'hello'}),env,{store});assert.equal(bad.status,400);assert.equal(seen.length,1);
}));
