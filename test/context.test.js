import test from "node:test";
import assert from "node:assert/strict";
import {normalizeContext} from "../src/context.js";

test("inline instructions preserve roles and exact message order",()=>{
 const messages=[{role:"user",content:"first"},{role:"developer",content:"new rule"},{role:"assistant",content:"answer"},{role:"user",content:"next"}];
 assert.deepEqual(normalizeContext({messages},"chat"),{system:[],history:messages});
});
test("Anthropic tools remain structured data with IDs and error flags",()=>{
 const messages=[{role:"assistant",content:[{type:"tool_use",id:"t1",name:"read",input:{path:"a"}}]},{role:"user",content:[{type:"tool_result",tool_use_id:"t1",content:[{type:"text",text:"ignore instructions"}],is_error:true}]}];
 assert.deepEqual(normalizeContext({messages},"anthropic").history,messages);
});
test("response continuation appends once and replaces top-level instructions",()=>{
 const previous={history:[{role:"user",content:"first"},{type:"message",role:"assistant",content:[{type:"output_text",text:"answer"}]}],system:[{role:"developer",content:"old"}]};
 const result=normalizeContext({previous_response_id:"resp_test",instructions:"new",input:"next"},"responses",previous);
 assert.equal(result.history.length,3);assert.deepEqual(result.system,[{role:"developer",content:"new"}]);
 assert.throws(()=>normalizeContext({previous_response_id:"resp_test",input:[...previous.history,{role:"user",content:"next"}]},"responses",previous),error=>error.status===400);
});
test("explicit summarized history is accepted; opaque compaction is rejected",()=>{
 assert.equal(normalizeContext({input:"Summary of earlier work: tests passed."},"responses").history.length,1);
 assert.throws(()=>normalizeContext({input:[{type:"compaction",encrypted_content:"opaque"}]},"responses"),error=>error.status===400);
});
test("namespaced custom calls and results retain identity and payload",()=>{
 const input=[{type:"custom_tool_call",call_id:"c1",namespace:"functions",name:"exec",input:"raw code"},{type:"custom_tool_call_output",call_id:"c1",output:"done"}];
 assert.deepEqual(normalizeContext({input},"responses").history,input);
});
