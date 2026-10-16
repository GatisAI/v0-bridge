// Pure browser-side .env serializer. Never contacts the server or persists values.
export const DEFAULT_MODELS=[
 {id:'gpt-6-astra',upstreamId:'openai/gpt-6-astra',alias:'astra',label:'GPT-6 Astra'},
 {id:'claude-fable-5.1',upstreamId:'anthropic/claude-fable-5.1',alias:'fable',label:'Claude Fable 5.1'},
 {id:'claude-opus-5.5',upstreamId:'anthropic/claude-opus-5.5',alias:'opus',label:'Claude Opus 5.5'},
 {id:'gpt-6.1-sol',upstreamId:'openai/gpt-6.1-sol',alias:'sol',label:'GPT-6.1 Sol'}
];
export function normalizeModelList(list){
 if(!Array.isArray(list)||!list.length||list.length>20)throw new Error('MODELS_JSON must contain 1-20 entries.');
 const names=new Map(),upstreams=new Set();
 return list.map(value=>{
  const x=typeof value==='string'?{id:value}:value;
  if(!x||typeof x!=='object'||Array.isArray(x)||typeof x.id!=='string')throw new Error('Invalid model entry.');
  const known=DEFAULT_MODELS.find(m=>m.id===x.id||m.upstreamId===x.id);
  const legacy=x.id.includes('/');
  const id=legacy?(x.publicId??known?.id):x.id;
  const upstreamId=x.upstreamId??(legacy?x.id:known?.upstreamId);
  if(typeof id!=='string'||!/^[A-Za-z0-9._-]{1,160}$/.test(id))throw new Error('Public model ID must have no vendor prefix. Unknown legacy IDs require explicit publicId or {id,upstreamId}.');
  if(typeof upstreamId!=='string'||!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(upstreamId)||upstreamId.length>160)throw new Error('Explicit upstreamId required for custom models.');
  if(legacy&&upstreamId!==x.id)throw new Error('Legacy id and upstreamId disagree.');
  if(x.publicId!==undefined&&x.publicId!==id)throw new Error('Conflicting publicId.');
  const reserved=DEFAULT_MODELS.find(m=>m.id===id||m.upstreamId===upstreamId);
  if(reserved&&(reserved.id!==id||reserved.upstreamId!==upstreamId))throw new Error('Built-in public/upstream mapping cannot be reassigned.');
  const alias=x.alias??known?.alias??id;
  const extras=x.aliases??[];
  if(!Array.isArray(extras))throw new Error('aliases must be an array.');
  const declared=[alias,...extras];
  if(declared.some(a=>typeof a!=='string'||!/^[A-Za-z0-9._/-]{1,160}$/.test(a))||new Set(declared).size!==declared.length)throw new Error('Invalid or duplicate model aliases.');
  if(upstreams.has(upstreamId))throw new Error('Duplicate upstream model mapping.');
  upstreams.add(upstreamId);
  const accepted=new Set([id,upstreamId,...declared]);
  for(const name of accepted){
   const builtin=DEFAULT_MODELS.find(m=>[m.id,m.upstreamId,m.alias].includes(name));
   if(builtin&&builtin.upstreamId!==upstreamId)throw new Error('Alias conflicts with a built-in model.');
   if(names.has(name))throw new Error('Duplicate or ambiguous model ID/alias: '+name);
   names.set(name,id);
  }
  return {id,upstreamId,alias,...(extras.length?{aliases:extras}:{}),label:typeof x.label==='string'?x.label.slice(0,100):(known?.label??id)};
 });
}
export function validateModels(raw){let list;try{list=JSON.parse(raw);}catch{throw new Error('MODELS_JSON must be valid JSON.');}return normalizeModelList(list);}
export function buildEnv(v){const required=['V0_API_KEY','GATEWAY_API_KEY','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','STATE_NAMESPACE'];for(const k of required)if(typeof v[k]!=='string'||!v[k].trim())throw new Error(k+' wajib diisi.');if(v.GATEWAY_API_KEY.trim().length<24)throw new Error('Gateway key minimal24karakter.');if(v.ADMIN_PIN&&v.ADMIN_PIN.length<6)throw new Error('PIN minimal6karakter atau kosong.');if(v.ADMIN_PIN?.length>64)throw new Error('PIN maksimal64karakter.');const url=new URL(v.UPSTASH_REDIS_REST_URL.trim());if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Redis URL harus HTTPS REST URL tanpa credential/query.');if(!/^[A-Za-z0-9:_-]{1,100}$/.test(v.STATE_NAMESPACE))throw new Error('Namespace hanya huruf, angka, :, _, -.');const ttl=Number(v.STATE_TTL_SECONDS),daily=Number(v.MAX_DAILY_GENERATIONS);if(!Number.isInteger(ttl)||ttl<3600||ttl>2592000)throw new Error('TTL harus3600–2592000detik.');if(!Number.isInteger(daily)||daily<1||daily>100000)throw new Error('MAX_DAILY_GENERATIONS harus1–100000.');const models=validateModels(v.MODELS_JSON);const out={V0_API_KEY:v.V0_API_KEY.trim(),GATEWAY_API_KEY:v.GATEWAY_API_KEY.trim(),GATEWAY_KEYS_JSON:'',ADMIN_PIN:v.ADMIN_PIN||'',UPSTASH_REDIS_REST_URL:url.origin,UPSTASH_REDIS_REST_TOKEN:v.UPSTASH_REDIS_REST_TOKEN.trim(),STATE_NAMESPACE:v.STATE_NAMESPACE,STATE_TTL_SECONDS:String(ttl),MODELS_JSON:JSON.stringify(models),MAX_DAILY_GENERATIONS:String(daily),MAX_DAILY_REPORTED_COST:'30',MAX_SESSION_GENERATIONS:'100',REQUEST_DEADLINE_SECONDS:'250',V0_WAIT_SECONDS:'110',V0_POLL_MS:'2000',V0_EFFORT_MODE:'prompt_hint'};
 for(const [k,value]of Object.entries(out))if(/[\r\n\u0000']/.test(value))throw new Error(k+': hapus newline, karakter kontrol atau apostrof sebelum export.');
 return {values:out,text:'# Generated locally in your browser. NEVER commit this file.\n# Import into Vercel Production env, then REDEPLOY.\n# Remove old GATEWAY_KEYS_JSON if switching to this single GATEWAY_API_KEY.\n'+Object.entries(out).map(([k,val])=>`${k}='${val}'`).join('\n')+'\n'};}
