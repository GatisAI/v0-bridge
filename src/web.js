import {readFileSync}from'node:fs';
const files=new Map([
 ['/',{body:readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),type:'text/html; charset=utf-8'}],
 ['/assets/site.css',{body:readFileSync(new URL('../public/assets/site.css',import.meta.url),'utf8'),type:'text/css; charset=utf-8'}],
 ['/assets/site.js',{body:readFileSync(new URL('../public/assets/site.js',import.meta.url),'utf8'),type:'text/javascript; charset=utf-8'}],
 ['/assets/env.js',{body:readFileSync(new URL('../public/assets/env.js',import.meta.url),'utf8'),type:'text/javascript; charset=utf-8'}]
]);
export function serveWeb(path){const f=files.get(path);if(!f)return null;return new Response(f.body,{headers:{'Content-Type':f.type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"}});}
