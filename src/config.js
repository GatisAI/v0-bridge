import {BridgeError} from './util.js';
import {DEFAULT_MODELS,normalizeModelList} from '../public/assets/env.js';
export {DEFAULT_MODELS};
export function readModels(env={}){
 try{return normalizeModelList(env.MODELS_JSON?JSON.parse(env.MODELS_JSON):DEFAULT_MODELS);}
 catch(error){throw new BridgeError('Invalid MODELS_JSON: '+error.message,503);}
}
export function modelRegistry(env={}){
 const list=readModels(env);
 return {ids:list.map(m=>m.id),entries:Object.fromEntries(list.map(m=>[m.id,m])),aliases:Object.fromEntries(list.flatMap(m=>[m.id,m.upstreamId,m.alias,...(m.aliases||[])].map(name=>[name,m.id])))};
}
export function hasGatewayKey(env){if(env.GATEWAY_KEYS_JSON){try{const k=JSON.parse(env.GATEWAY_KEYS_JSON);return k&&!Array.isArray(k)&&typeof k==='object'&&Object.keys(k).length>0&&Object.entries(k).every(([id,v])=>/^[A-Za-z0-9_-]{1,64}$/.test(id)&&typeof v==='string'&&v.length>=24);}catch{return false;}}return typeof env.GATEWAY_API_KEY==='string'&&env.GATEWAY_API_KEY.length>=24;}
export function setupStatus(env){let models,modelsValid=true;try{models=readModels(env);}catch{models=DEFAULT_MODELS;modelsValid=false;}const complete=Boolean(env.V0_API_KEY?.trim()&&hasGatewayKey(env)&&env.UPSTASH_REDIS_REST_URL?.startsWith('https://')&&env.UPSTASH_REDIS_REST_TOKEN?.trim()&&modelsValid);return {configured:complete,setupRequired:!complete,pinRequired:Boolean(env.ADMIN_PIN),models,retentionHours:Number(env.STATE_TTL_SECONDS||172800)/3600,configurationVerified:false};}
