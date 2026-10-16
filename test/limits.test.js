import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {handle} from '../src/app.js';
import {RedisStore,MemoryStore} from '../src/store.js';
const env={GATEWAY_API_KEY:'limits-test-key-000000000000000000'};
const redisEnv={UPSTASH_REDIS_REST_URL:'https://redis.test',UPSTASH_REDIS_REST_TOKEN:'fake-test-token'};
const request=body=>new Request('http://local/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+env.GATEWAY_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(body)});
const engine=async()=>({data:{id:'test-response',output:[]},billing:{chat_id:'test-chat'}});
test('request above old 750 KB limit is accepted without calling real upstream',async()=>{
 const response=await handle(request({model:'astra',input:'x'.repeat(1000000)}),env,{store:new MemoryStore(),runEngine:engine});
 assert.equal(response.status,200);
});
test('request limit is configurable and rejects above the configured bytes',async()=>{
 const response=await handle(request({model:'astra',input:'x'.repeat(5000)}),{...env,MAX_REQUEST_BODY_BYTES:'4096'},{store:new MemoryStore(),runEngine:engine});
 assert.equal(response.status,413);
});
test('reads both original JSON and manual-hotfix gz state',async()=>{
 const store=new RedisStore(redisEnv),record={history:[{role:'user',content:'retained'}],status:'ok'};
 for(const encoded of [JSON.stringify(record),'gz:'+gzipSync(JSON.stringify(record)).toString('base64')]){
  store.command=async()=>encoded;
  assert.deepEqual(await store.get('session:test'),record);
 }
});
test('large repetitive state survives compression and a new store instance',async()=>{
 const records=new Map();const command=async args=>{if(args[0]==='SET'){records.set(args[1],args[2]);return 'OK';}return records.get(args[1])??null;};
 const first=new RedisStore(redisEnv);first.command=command;
 const record={history:[{role:'user',content:'large coding history '.repeat(100000)}]};
 await first.put('session:test',record);
 const second=new RedisStore(redisEnv);second.command=command;
 assert.deepEqual(await second.get('session:test'),record);
 assert(Buffer.byteLength(records.get(first.key('session:test')))<950000);
});

import {randomBytes} from 'node:crypto';
import {encodeState,decodeState,commandBody} from '../src/state-codec.js';
import {limits,dailyCost} from '../src/limits.js';
import {readBody} from '../src/util.js';
import {runEngine} from '../src/engine.js';
import {MODELS} from '../src/core.js';

test('invalid configuration fails explicitly rather than silently reverting',()=>{
 for(const config of [{MAX_REQUEST_BODY_BYTES:'NaN'},{MAX_RAW_STATE_BYTES:'0'},{MAX_REDIS_REQUEST_BYTES:'10000001'},{REQUEST_DEADLINE_SECONDS:'251'},{V0_WAIT_SECONDS:'241'},{V0_POLL_MS:'19'}])assert.throws(()=>limits(config),e=>e.status===503);
 for(const value of ['NaN','Infinity','0','-1'])assert.throws(()=>dailyCost({MAX_DAILY_REPORTED_COST:value}),e=>e.status===503);
 assert.equal(limits({MAX_REQUEST_BODY_BYTES:'4096'}).requestBytes,4096);
});
test('request limits measure UTF-8 bytes, accept the exact boundary and reject chunked overflow',async()=>{
 const body=JSON.stringify({text:'??'.repeat(200)}),bytes=Buffer.byteLength(body);
 const make=()=>new Request('http://local',{method:'POST',body});
 assert.deepEqual(await readBody(make(),bytes),JSON.parse(body));
 await assert.rejects(readBody(make(),bytes-1),e=>e.status===413);
 const declared=new Request('http://local',{method:'POST',headers:{'Content-Length':String(bytes)},body});
 await assert.rejects(readBody(declared,bytes-1),e=>e.status===413);
});
test('raw-state limit rejects compressible content and decompression is bounded',async()=>{
 const record={content:'x'.repeat(5000)},config={MAX_RAW_STATE_BYTES:'1024'};
 await assert.rejects(encodeState(record,config),e=>e.status===413);
 await assert.rejects(decodeState('gz:'+gzipSync(JSON.stringify(record)).toString('base64'),config),e=>e.status===503);
 for(const text of ['gz:not-base64','{broken'])await assert.rejects(decodeState(text),e=>e.status===503);
});
test('incompressible state obeys stored limit; Redis command includes JSON overhead',async()=>{
 await assert.rejects(encodeState({content:randomBytes(12000).toString('base64')},{MAX_STORED_STATE_BYTES:'1024'}),e=>e.status===413);
 const args=['SET','key','"'.repeat(1500),'EX',3600];
 assert(Buffer.byteLength(args[2])<2048);
 assert.throws(()=>commandBody(args,{MAX_REDIS_REQUEST_BYTES:'2048'}),e=>e.status===413);
 const size=Buffer.byteLength(JSON.stringify(args));
 assert.equal(Buffer.byteLength(commandBody(args,{MAX_REDIS_REQUEST_BYTES:String(size)})),size);
});
test('oversized next turn preserves old session and consumes no upstream calls or reservations',async()=>{
 const config={MAX_RAW_STATE_BYTES:'2048'},store=new MemoryStore(config),scope='preflight';
 const old={status:'ok',history:[{role:'user',content:'first'}],chat_id:'existing-chat',generations:1};
 await store.put('session:'+scope,old);
 let calls=0;const original=global.fetch;global.fetch=async()=>{calls++;throw Error('Unexpected upstream');};
 try{
  await assert.rejects(runEngine({body:{model:'astra',messages:[...old.history,{role:'user',content:'x'.repeat(6000)}]},p:'chat',scope,keyId:'main',store,env:config,signal:new AbortController().signal}),e=>e.status===413);
  assert.equal(calls,0);assert.equal(store.usage.generations,0);
  assert.deepEqual(await store.get('session:'+scope),old);
  assert.equal(store.locks.size,0);
 }finally{global.fetch=original;}
});
function mockRedis(records){
 const store=new RedisStore(redisEnv);
 store.command=async args=>{if(args[0]==='SET'){records.set(args[1],args[2]);return 'OK';}if(args[0]==='GET')return records.get(args[1])??null;throw Error('Unexpected command '+args[0]);};
 store.lock=async()=>async()=>{};store.reserve=async()=> 'test-day';store.charge=async()=>{};
 return store;
}
test('large Responses history survives store recreation, continuation and cached retry',async()=>{
 const records=new Map(),original=global.fetch,paths=[];let posts=0;
 global.fetch=async(url,options)=>{paths.push(new URL(url).pathname);if(options.method==='POST'){posts++;return Response.json({chatId:'large-chat',messageId:'m'+posts});}return Response.json({finishReason:'stop',parts:[{type:'text',text:JSON.stringify({type:'message',text:'answer-'+posts})}],usage:{model:MODELS[0],tokens:{input:1,output:1},creditsCost:{total:0}}});};
 const setup={p:'responses',scope:'large-history',keyId:'main',env:{V0_API_KEY:'fake',V0_BASE_URL:'http://upstream.test/v2'},signal:new AbortController().signal};
 try{
  const first=await runEngine({...setup,store:mockRedis(records),body:{model:'astra',input:'coding context '.repeat(80000)}});
  const body={model:'astra',previous_response_id:first.data.id,input:'continue'};
  const second=await runEngine({...setup,store:mockRedis(records),body});
  assert.equal(second.billing.chat_id,'large-chat');assert.equal(second.billing.upstream_mode,'continue');
  const cached=await runEngine({...setup,store:mockRedis(records),body});
  assert.equal(cached.data.id,second.data.id);assert.equal(cached.billing.cached,true);assert.equal(posts,2);
  assert(paths.includes('/v2/chats/large-chat/messages/async'));
  assert([...records.values()].some(value=>value.startsWith('gz:')));
 }finally{global.fetch=original;}
});
test('envelope repair cannot exceed the session generation safeguard',async()=>{
 const config={MAX_SESSION_GENERATIONS:'1',V0_API_KEY:'fake',V0_BASE_URL:'http://upstream.test/v2'},store=new MemoryStore(config),original=global.fetch;let posts=0;
 global.fetch=async(url,options)=>options.method==='POST'?(posts++,Response.json({chatId:'repair-chat',messageId:'m1'})):Response.json({finishReason:'stop',parts:[{type:'text',text:'not an envelope'}],usage:{model:MODELS[0],tokens:{input:1,output:1},creditsCost:{total:0}}});
 try{
  await assert.rejects(runEngine({body:{model:'astra',messages:[{role:'user',content:'hello'}]},p:'chat',scope:'repair-limit',keyId:'main',store,env:config,signal:new AbortController().signal}),e=>e.status===429);
  assert.equal(posts,1);assert.equal(store.usage.generations,1);assert.equal((await store.get('session:repair-limit')).status,'failed');
 }finally{global.fetch=original;}
});
test('Redis daily and rate settings validate and pass configured values',async()=>{
 const store=new RedisStore({...redisEnv,MAX_DAILY_GENERATIONS:'321',MAX_DAILY_REPORTED_COST:'12.5',MAX_REQUESTS_PER_MINUTE:'3'});let args;
 store.command=async command=>{args=command;return 1;};await store.reserve();assert.deepEqual(args.slice(-2),[321,12.5]);
 store.command=async()=>4;await assert.rejects(store.rate('main'),e=>e.status===429);
 const invalid=new MemoryStore({MAX_DAILY_GENERATIONS:'NaN'});await assert.rejects(invalid.reserve(),e=>e.status===503);
 assert.throws(()=>new RedisStore({...redisEnv,STATE_TTL_SECONDS:'garbage'}),e=>e.status===503);
});
