import test from 'node:test';
import assert from 'node:assert/strict';
import {create} from 'jsondiffpatch';
import {readSse,patchParts,createGeneration} from '../src/upstream.js';

const encoder=new TextEncoder();
const env={V0_API_KEY:'test-only',V0_BASE_URL:'http://upstream.test/v2'};
const payload={message:'test'};
const usage={model:'test-model',tokens:{input:2,output:3},creditsCost:{total:0.01}};
const initial={object:'message',id:'message_1',chatId:'chat_1',role:'assistant',parts:[],finishReason:null};
const terminal={...initial,parts:[{type:'text',text:'answer'}],finishReason:'stop',usage};
function body(text,bytewise=false){
 const bytes=encoder.encode(text);
 return new ReadableStream({start(controller){
  if(bytewise)for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));
  else controller.enqueue(bytes);
  controller.close();
 }});
}
const wire=items=>items.map(item=>'data: '+JSON.stringify(item)+'\n\n').join('');
const collect=async stream=>{const out=[];for await(const value of stream)out.push(value);return out;};

test('SSE preserves split UTF-8, CRLF and multiline data and ignores comments',async()=>{
 const text=': heartbeat\r\nevent: update\r\ndata: {"text":\r\ndata: "日本語"}\r\n\r\n';
 assert.deepEqual(await collect(readSse(body(text,true))),['{"text":\n"日本語"}']);
});
test('parts patches preserve input and apply standard and optimized deltas',()=>{
 const before=[{type:'text',text:'first'}],after=[{type:'text',text:'first next'}];
 assert.deepEqual(patchParts(before,create({}).diff(before,after)),after);
 assert.equal(before[0].text,'first');
 assert.deepEqual(patchParts([['first']],[[0,0,' next'],9,9]),[['first next']]);
 assert.throws(()=>patchParts(before,[[999,'bad'],9,9]),/Invalid upstream parts delta/);
});
test('parts patches reject prototype keys without altering global prototypes',()=>{
 assert.throws(()=>patchParts([],JSON.parse('{"__proto__":{"polluted":[true]}}')),/Unsafe/);
 assert.equal({}.polluted,undefined);
});
test('upstream streams snapshots, usage and parts before resolving the terminal message',async()=>{
 const calls=[],updates=[];
 const items=[{object:'chat',id:'chat_1'},initial,{object:'message.parts.chunk',id:'message_1',delta:{_t:'a',0:[{type:'text',text:'answer'}]}},{object:'message.usage',id:'message_1',usage},terminal];
 const result=await createGeneration({env,payload,onUpdate:update=>updates.push(structuredClone(update)),fetchImpl:async(url,options)=>{
  calls.push({url,options});return new Response(body(wire(items),true));
 }});
 assert.equal(calls.length,1);assert.equal(calls[0].url,env.V0_BASE_URL+'/chats/stream');
 assert.equal(calls[0].options.redirect,'error');
 assert.equal(result.message.finishReason,'stop');assert.deepEqual(result.message.usage,usage);
 assert(updates.some(update=>!update.finished&&update.parts[0]?.text==='answer'));
});
test('truncated generation stops identified work without retrying generation',async()=>{
 const calls=[];
 await assert.rejects(createGeneration({env,payload,fetchImpl:async(url)=>{
  calls.push(url);
  return url.endsWith('/stop')?new Response(null,{status:204}):new Response(body(wire([{object:'chat',id:'chat_1'},initial])));
 }}),/without a terminal message/);
 assert.deepEqual(calls,[env.V0_BASE_URL+'/chats/stream',env.V0_BASE_URL+'/chats/chat_1/messages/message_1/stop']);
});
test('mismatched message identity fails and stops the original generation',async()=>{
 const calls=[];
 await assert.rejects(createGeneration({env,payload,fetchImpl:async(url)=>{
  calls.push(url);
  return url.endsWith('/stop')?new Response(null,{status:204}):new Response(body(wire([{object:'chat',id:'chat_1'},initial,{object:'message.usage',id:'other',usage}])));
 }}),/Mismatched/);
 assert.equal(calls[1],env.V0_BASE_URL+'/chats/chat_1/messages/message_1/stop');
});
test('aborting a blocked SSE read cancels its reader',async()=>{
 const aborter=new AbortController();let cancelled=false;
 const stream=new ReadableStream({cancel(){cancelled=true;}});
 const result=collect(readSse(stream,aborter.signal));aborter.abort();
 await assert.rejects(result,error=>error.status===504);assert.equal(cancelled,true);
});
test('SSE response size limit cancels reading',async()=>{
 await assert.rejects(collect(readSse(body('data: too large\n\n'),undefined,4)),/size limit/);
});


// Real create-chat wire shape observed on 2026-10-16:
// chat -> parts chunk -> usage -> chat; no object:"message" snapshot.
const createWire=[
 {object:'chat',id:'chat_1'},
 {object:'message.parts.chunk',id:'message_1',delta:{_t:'a',0:[{type:'text',text:'answer'}]}},
 {object:'message.usage',id:'message_1',usage},
 {object:'chat',id:'chat_1'}
];
const messageUrl=env.V0_BASE_URL+'/chats/chat_1/messages/message_1';
function reconciledFetch(snapshot=terminal,items=createWire){
 const calls=[];
 return {calls,fetchImpl:async(url,options)=>{
  calls.push({url,method:options.method});
  if(url.endsWith('/chats/stream'))return new Response(body(wire(items),true));
  if(url.endsWith('/stop'))return new Response(null,{status:204});
  assert.equal(url,messageUrl);assert.equal(options.method,'GET');
  return Response.json(typeof snapshot==='function'?snapshot():snapshot);
 }};
}
test('create-chat closing snapshot is reconciled using GET, never a second generation',async()=>{
 const mock=reconciledFetch(),updates=[];
 const result=await createGeneration({env,payload,...mock,onUpdate:x=>updates.push(structuredClone(x))});
 assert.equal(result.message.finishReason,'stop');assert.deepEqual(result.message.parts,terminal.parts);
 assert.deepEqual(result.message.usage,usage);
 assert.deepEqual(mock.calls,[{url:env.V0_BASE_URL+'/chats/stream',method:'POST'},{url:messageUrl,method:'GET'}]);
 assert.equal(updates.at(-1).finished,true);
});
test('usage before EOF also reconciles when the closing chat snapshot is missing',async()=>{
 const mock=reconciledFetch(terminal,createWire.slice(0,-1));
 const result=await createGeneration({env,payload,...mock});
 assert.equal(result.message.finishReason,'stop');assert.equal(mock.calls.length,2);
});
test('closing chat without a usage event uses authoritative message usage',async()=>{
 const mock=reconciledFetch(terminal,createWire.filter(x=>x.object!=='message.usage'));
 const result=await createGeneration({env,payload,...mock});
 assert.deepEqual(result.message.usage,usage);
});
test('reconciliation polls pending message then completes without replaying POST',async()=>{
 let reads=0;const mock=reconciledFetch(()=>++reads===1?initial:terminal);
 const result=await createGeneration({env:{...env,V0_POLL_MS:'20'},payload,...mock});
 assert.equal(result.message.finishReason,'stop');assert.equal(reads,2);
 assert.equal(mock.calls.filter(x=>x.method==='POST').length,1);
});
test('closing chat and usage are not themselves proof of message completion',async()=>{
 const aborter=new AbortController();const mock=reconciledFetch(()=>{
  aborter.abort();return initial;
 });
 await assert.rejects(createGeneration({env,payload,signal:aborter.signal,...mock}),e=>e.status===504);
 assert.equal(mock.calls.filter(x=>x.url.endsWith('/chats/stream')).length,1);
 assert(mock.calls.some(x=>x.url.endsWith('/stop')));
});
test('reconciled message cannot switch chat identity',async()=>{
 const mock=reconciledFetch({...terminal,chatId:'other_chat'});
 await assert.rejects(createGeneration({env,payload,...mock}),/Mismatched upstream message chat/);
});
test('reconciled message cannot switch assistant identity',async()=>{
 const mock=reconciledFetch({...terminal,id:'other_message'});
 await assert.rejects(createGeneration({env,payload,...mock}),/Invalid upstream message identity/);
});
test('reconciled user message is not accepted as completed assistant output',async()=>{
 const mock=reconciledFetch({...terminal,role:'user'});
 await assert.rejects(createGeneration({env,payload,...mock}),/Invalid upstream assistant message/);
});
test('non-stop finishReason is preserved for engine validation, not rewritten to success',async()=>{
 const mock=reconciledFetch({...terminal,finishReason:'length'});
 const result=await createGeneration({env,payload,...mock});
 assert.equal(result.message.finishReason,'length');assert(!mock.calls.some(x=>x.url.endsWith('/stop')));
});
test('HTTP403 at stream creation is explicit, stage-specific, and never retried',async()=>{
 const calls=[];
 await assert.rejects(createGeneration({env,payload,fetchImpl:async(url)=>{
  calls.push(url);return new Response('private upstream body',{status:403});
 }}),e=>e.status===502&&/Upstream HTTP 403 during create_stream/.test(e.message)&&!e.message.includes('private'));
 assert.deepEqual(calls,[env.V0_BASE_URL+'/chats/stream']);
});
test('reconciliation HTTP failure identifies the stage without replaying generation',async()=>{
 const calls=[];
 await assert.rejects(createGeneration({env,payload,fetchImpl:async(url,options)=>{
  calls.push({url,method:options.method});
  if(url.endsWith('/chats/stream'))return new Response(body(wire(createWire)));
  if(url.endsWith('/stop'))return new Response(null,{status:204});
  return new Response('private upstream body',{status:403});
 }}),e=>e.status===502&&/during message_reconciliation/.test(e.message));
 assert.equal(calls.filter(x=>x.url.endsWith('/chats/stream')).length,1);
});
test('observed v0 HTTP403 rate-limit JSON becomes429, never a permission retry',async()=>{
 let calls=0;
 await assert.rejects(createGeneration({env,payload,fetchImpl:async()=>{
  calls++;return Response.json({message:'You are being rate limited. Please try again later.'},{status:403});
 }}),e=>e.status===429&&/Upstream rate limit \(HTTP 403\)/.test(e.message));
 assert.equal(calls,1);
});
test('ordinary HTTP403 permission JSON stays an upstream failure without body disclosure',async()=>{
 await assert.rejects(createGeneration({env,payload,fetchImpl:async()=>Response.json({message:'permission denied: private data'},{status:403})}),e=>e.status===502&&!e.message.includes('private data'));
});
test('oversized upstream denial is bounded and never exposed',async()=>{
 await assert.rejects(createGeneration({env,payload,fetchImpl:async()=>new Response('x'.repeat(10000),{status:403})}),e=>e.status===502&&!e.message.includes('xxxxx'));
});
