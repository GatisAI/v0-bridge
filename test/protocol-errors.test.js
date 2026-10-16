import test from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../src/app.js';
import {failure,BridgeError} from '../src/util.js';
const env={GATEWAY_API_KEY:'regression-key-000000000000000000'};
test('Anthropic authentication failures use the Anthropic envelope before body parsing',async()=>{
 const req=new Request('http://local/v1/messages',{method:'POST',headers:{'x-api-key':'invalid','Content-Type':'application/json'},body:'{'});
 const response=await handle(req,env);const body=await response.json();
 assert.equal(response.status,401);assert.equal(body.type,'error');assert.equal(body.error.type,'authentication_error');
});
test('Vercel rewritten Anthropic route preserves authentication error format',async()=>{
 const response=await handle(new Request('http://local/api/gateway?route=/v1/messages',{method:'POST',headers:{'x-api-key':'invalid'}}),env);
 assert.equal(response.status,401);assert.equal((await response.json()).type,'error');
});
test('Anthropic failures map HTTP status to documented error types',async()=>{
 for(const [status,type] of [[400,'invalid_request_error'],[401,'authentication_error'],[403,'permission_error'],[404,'not_found_error'],[413,'request_too_large'],[429,'rate_limit_error'],[500,'api_error'],[502,'api_error'],[529,'overloaded_error']]){
  const response=failure(new BridgeError('test error',status),'anthropic');
  assert.equal(response.status,status);const body=await response.json();assert.equal(body.type,'error');assert.equal(body.error.type,type,'status '+status);
 }
});
test('OpenAI authentication error shape remains unchanged',async()=>{
 const response=await handle(new Request('http://local/v1/responses',{method:'POST',headers:{Authorization:'Bearer invalid'}}),env);
 assert.equal(response.status,401);const body=await response.json();assert.equal(body.error.type,'bridge_error');assert.equal(body.error.code,401);
});