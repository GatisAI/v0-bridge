import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareGeneration,responseKey} from '../src/engine.js';
import {MemoryStore} from '../src/store.js';
import {MODELS} from '../src/core.js';
const env={V0_API_KEY:'fixture-only'},body={model:'astra',input:'next',previous_response_id:'resp_test'};
const prepare=(store,data=body,keyId='main')=>prepareGeneration({body:data,p:'responses',keyId,store,env});
const record={version:2,model:MODELS[0],history:[{role:'user',content:'first'},{role:'assistant',content:'answer'}]};
test('lineage is isolated by stable key ID and model',async()=>{
 const store=new MemoryStore();await store.put(responseKey('main','resp_test'),record);
 assert.equal((await prepare(store)).history.length,3);
 await assert.rejects(prepare(store,body,'other'),error=>error.status===400);
 await assert.rejects(prepare(store,{...body,model:MODELS[1]}),error=>error.status===400);
});
test('legacy response links and sessions are never adopted',async()=>{
 const store=new MemoryStore();await store.put('response-link:main:resp_test',{scope:'old',model:MODELS[0]});
 await store.put('session:old',{history:record.history,chat_id:'legacy-chat'});
 await assert.rejects(prepare(store),error=>error.status===400);
 assert.equal(store.usage.generations,0);
});
test('new response records reject unsupported versions and expired references',async()=>{
 const store=new MemoryStore();await store.put(responseKey('main','resp_test'),{...record,version:1});
 await assert.rejects(prepare(store),error=>error.status===400);
 store.data.clear();await assert.rejects(prepare(store),error=>error.status===400);
});
test('reconstruction does not mutate a parent and supports independent branches',async()=>{
 const store=new MemoryStore();await store.put(responseKey('main','resp_test'),record);
 const [a,b]=await Promise.all([prepare(store,{...body,input:'branch A'}),prepare(store,{...body,input:'branch B'})]);
 assert.equal(a.history.at(-1).content,'branch A');assert.equal(b.history.at(-1).content,'branch B');
 assert.deepEqual(await store.get(responseKey('main','resp_test')),record);assert.equal(store.usage.generations,0);
});
