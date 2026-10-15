import fs from 'node:fs';
await import('../api/gateway.js');
const v=JSON.parse(fs.readFileSync(new URL('../vercel.json',import.meta.url)));
if(v.functions['api/gateway.js'].maxDuration<280)throw new Error('Function deadline config too short.');
if(!v.rewrites?.some(x=>x.source==='/v1/:path*'))throw new Error('Missing API rewrites.');
console.log('Source imports and deployment configuration validated. This is NOT a remote Vercel deployment test.');
