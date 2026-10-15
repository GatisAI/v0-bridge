// BRIDGE_BASE_URL=https://your.vercel.app GATEWAY_CLIENT_KEY=... node examples/chat.mjs
const base=process.env.BRIDGE_BASE_URL?.replace(/\/$/,'');const key=process.env.GATEWAY_CLIENT_KEY;
if(!base||!key)throw new Error('Set BRIDGE_BASE_URL and GATEWAY_CLIENT_KEY.');
const headers={Authorization:'Bearer '+key,'Content-Type':'application/json','X-V0-Session':'example-'+crypto.randomUUID()};
const messages=[{role:'user',content:'Remember the word MANGOSTEEN. Reply OK.'}];
for(const prompt of [null,'What word did I ask you to remember?']){
 if(prompt)messages.push({role:'user',content:prompt});
 const r=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'astra',messages})});const data=await r.json();if(!r.ok)throw new Error(JSON.stringify(data));const answer=data.choices[0].message;console.log(answer.content);messages.push(answer);
}
