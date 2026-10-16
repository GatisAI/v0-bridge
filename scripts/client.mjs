// Optional launcher. API use does not depend on this script.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import spawn from 'cross-spawn';
const args=process.argv.slice(2);const client=args.shift();if(!['codex','claude'].includes(client))throw new Error('Usage: node scripts/client.mjs codex|claude --project PATH [--session NAME] [--resume]');
const option=(name,def)=>{const i=args.indexOf(name);return i>=0?args[i+1]:def;};const resume=args.includes('--resume');const project=path.resolve(option('--project',process.cwd()));const session=option('--session',resume?null:crypto.randomUUID());if(!session||!/^[a-zA-Z0-9_-]{1,80}$/.test(session))throw new Error('--session required on resume; use letters/digits/_/- up to80.');
const base=(process.env.BRIDGE_BASE_URL||'http://127.0.0.1:8787').replace(/\/$/,'');const u=new URL(base);if(u.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(u.hostname))throw new Error('Use HTTPS for remote endpoints.');
const key=process.env.GATEWAY_CLIENT_KEY||process.env.GATEWAY_API_KEY;if(!key||key.length<24)throw new Error('Set GATEWAY_CLIENT_KEY to the bridge API key.');
const model=option('--model',client==='codex'?'gpt-6-astra':'claude-fable-5.1');if(!/^[a-zA-Z0-9._/-]{1,160}$/.test(model))throw new Error('Invalid model ID.');
const home=path.join(os.homedir(),'.v0-bridge-clients',client,session);if(fs.existsSync(home)&&!resume)throw new Error('Session exists: use --resume or a NEW session.');if(!fs.existsSync(home)&&resume)throw new Error('Saved client home not found.');fs.mkdirSync(home,{recursive:true});
const env={...process.env};for(const k of Object.keys(env))if(/^(UPSTASH_|KV_|POSTGRES_|ADMIN_)/.test(k)||['V0_API_KEY','GATEWAY_API_KEY','GATEWAY_KEYS_JSON','DATABASE_URL','ANTHROPIC_API_KEY','OPENAI_API_KEY'].includes(k))delete env[k];
let cmdArgs;
if(client==='codex'){
 env.CODEX_HOME=home;env.V0_BRIDGE_KEY=key;
 fs.writeFileSync(path.join(home,'config.toml'),`model_provider="v0bridge"\nmodel=${JSON.stringify(model)}\nmodel_reasoning_effort="high"\napproval_policy="on-request"\nsandbox_mode="workspace-write"\n[model_providers.v0bridge]\nname="v0 bridge (experimental)"\nbase_url=${JSON.stringify(base+'/v1')}\nenv_key="V0_BRIDGE_KEY"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\nhttp_headers={"X-V0-Session"=${JSON.stringify('codex-'+session)}}\n[features]\nshell_snapshot=false\nmulti_agent=false\n`);
 cmdArgs=['-C',project,...(resume?['resume','--last']:[])];
}else{
 Object.assign(env,{ANTHROPIC_BASE_URL:base,ANTHROPIC_AUTH_TOKEN:key,ANTHROPIC_CUSTOM_HEADERS:'X-V0-Session: claude-'+session,CLAUDE_CONFIG_DIR:home,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:'1',CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING:'1',ENABLE_TOOL_SEARCH:'false'});
 cmdArgs=['--model',model,'--effort','high','--tools','Read,Edit,Write,Bash,Glob,Grep','--setting-sources','',...(resume?['--continue']:[])];
}
console.log('Conversation session:',session,'| Resume using the SAME --session and --project.');
// cross-spawn resolves Windows .cmd/.exe launchers and quotes arguments safely.
const child=spawn(client,cmdArgs,{cwd:project,env,stdio:'inherit'});child.on('error',()=>{console.error('Install the coding client and ensure it is on PATH.');process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
