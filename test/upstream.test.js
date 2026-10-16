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

