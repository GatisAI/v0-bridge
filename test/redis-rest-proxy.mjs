// TEST-ONLY: exposes a local Redis through the subset of Upstash REST used here.
// It is NOT part of the deployed function and is not an actual Upstash service.
import http from 'node:http';import {createClient}from'redis';
const redis=createClient({url:process.env.LOCAL_REDIS_URL||'redis://127.0.0.1:6398'});await redis.connect();
const server=http.createServer(async(req,res)=>{try{if(req.headers.authorization!=='Bearer local-redis-test-token'){res.writeHead(401);res.end('{}');return;}let raw='';for await(const chunk of req)raw+=chunk;const command=JSON.parse(raw).map(String);let result=await redis.sendCommand(command);if(Buffer.isBuffer(result))result=result.toString();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result}));}catch(e){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:e.message}));}});
server.listen(Number(process.env.REDIS_REST_PORT||6399),'127.0.0.1',()=>console.log('Redis REST test adapter ready'));
