import http from 'node:http';
import {Readable} from 'node:stream';
import {handle} from '../src/app.js';
const port=Number(process.env.PORT||8787);
const server=http.createServer(async(req,res)=>{try{const ac=new AbortController();res.on('close',()=>{if(!res.writableEnded)ac.abort();});const request=new Request('http://127.0.0.1:'+port+req.url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Readable.toWeb(req),duplex:'half',signal:ac.signal});const response=await handle(request,process.env);res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();}catch{res.writeHead(500);res.end('Local adapter error');}});
server.listen(port,'127.0.0.1',()=>console.log('Local Node bridge: http://127.0.0.1:'+port));
