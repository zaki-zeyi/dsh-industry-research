// Real isolated DSH host + model transport failures after a real tool-acquired
// lock. --live-feishu uses existing authorized docs; default uses test storage.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {chromium} from '@playwright/test';
import {requiredScopes} from '../server/feishu-binding.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),dir=mkdtempSync(resolve(tmpdir(),'model-failure-host-'));
const packageRoot=process.argv.includes('--package-root')?resolve(process.argv[process.argv.indexOf('--package-root')+1]):root;
const live=process.argv.includes('--live-feishu'),output=resolve(root,'artifacts/diagnostics/model-failure-host-'+(live?'live':'fixture')+'.json');
let child,browser,page,log='',workbench,handlerError;const scenarios=new Map(),results=[];
const profile=resolve(dir,'profiles/model-failure');mkdirSync(resolve(profile,'node_modules'),{recursive:true});
symlinkSync(packageRoot,resolve(profile,'node_modules/dsh-industry-research'),'junction');
writeFileSync(resolve(profile,'package.json'),JSON.stringify({name:'model-failure-test',private:true,dependencies:{'dsh-industry-research':`link:${packageRoot}`},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-industry-research']}}}));
const cloud={live,rootToken:'Root123',libraryToken:'Library123',companyToken:'Company123',indexToken:'Index123',indexUrl:'https://example.feishu.cn/docx/Index123',scopes:requiredScopes,stateFile:resolve(dir,'cloud.json')};
let productionURL;
if(live){
  productionURL=JSON.parse(readFileSync(resolve(homedir(),'.dsh/industry-research/sessions/briefing-endpoint.json'),'utf8')).url;
  const tasks=(await(await fetch(productionURL+'/api/tasks?limit=100')).json()).items;assert.ok(!tasks.some(t=>['queued','running'].includes(t.status)),'当前工作台仍有任务运行，不并行写库');
  const prior=JSON.parse(readFileSync(resolve(root,'artifacts/diagnostics/lock-live-dev3-evidence.json'),'utf8'));
  const task=(await(await fetch(productionURL+'/api/tasks/'+prior.taskId)).json()).task;
  const db=new DatabaseSync(resolve(homedir(),'.dsh/industry-research/research.sqlite'),{readOnly:true});const meta=JSON.parse(db.prepare('SELECT body FROM terminals WHERE id=?').get(task.terminalId).body);db.close();
  const cli=JSON.parse(readFileSync(resolve(dirname(meta.larkClientPath),'lark-agent-config.json'),'utf8'));
  const lib=await(await fetch(productionURL+'/api/industry/library')).json();const target=lib.companies.find(c=>c.name==='后摩智能');assert.ok(target&&lib.manifestUrl);
  Object.assign(cloud,{command:cli.command,commandArgs:cli.args,profile:task.feishuApp.profile,rootToken:task.feishuRoot.folderToken,libraryToken:lib.folderToken,companyToken:target.url.split('/').at(-1),indexToken:lib.manifestUrl.split('/').at(-1),indexUrl:lib.manifestUrl});
}
writeFileSync(cloud.stateFile,JSON.stringify({writes:0,[cloud.companyToken]:{revision_id:1,content:'<title>后摩智能</title><p>已有真实事实；核验日期：2026-11-17</p>'},[cloud.indexToken]:{revision_id:1,content:JSON.stringify({companies:[{name:'后摩智能',url:`https://example.feishu.cn/docx/${cloud.companyToken}`,dimensions:['主营业务及产品'],updatedAt:'2026-11-16T00:00:00Z',added:1,conflicts:0}]})}}));
const configFile=resolve(dir,'cloud-config.json');writeFileSync(configFile,JSON.stringify(cloud));
const cliShim=resolve(dir,'lark.mjs');writeFileSync(cliShim,`import ${JSON.stringify(new URL('./fixtures/model-failure-lark.mjs',import.meta.url).href)};`);
const helper=fileURLToPath(new URL('./fixtures/model-failure-agent-step.mjs',import.meta.url));
function sse(res,call){
  res.writeHead(200,{'content-type':'text/event-stream'});
  const emit=(event,data)=>res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('message_start',{type:'message_start',message:{id:'acceptance_'+randomUUID(),type:'message',role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:1,output_tokens:0}}});
  if(call){emit('content_block_start',{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'tool_'+randomUUID(),name:call.name,input:{}}});emit('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(call.input)}});}
  else{emit('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}});emit('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'执行结束，交付已核对。'}});}
  emit('content_block_stop',{type:'content_block_stop',index:0});emit('message_delta',{type:'message_delta',delta:{stop_reason:call?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:10}});emit('message_stop',{type:'message_stop'});res.end();
}
function readMeta(id){const db=new DatabaseSync(resolve(dir,'workbench/research.sqlite'),{readOnly:true});try{return JSON.parse(db.prepare('SELECT body FROM terminals WHERE id=?').get(id).body);}finally{db.close();}}
const model=createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;if(!req.url.includes('/messages')){res.writeHead(404).end();return;}
  const body=JSON.parse(raw),text=JSON.stringify(body.messages??[]).replaceAll('\\\\','\\');
  const promptPath=[...text.matchAll(/请读取 (.+?prompt-[a-f0-9-]+\.txt)，按照/g)].at(-1)?.[1];
  if(!promptPath||!body.tools?.length){sse(res);return;}
  const prompt=readFileSync(promptPath,'utf8'),kind=/MODEL_FAILURE_(key|quota|network)/.exec(prompt)?.[1];
  if(!kind){sse(res);return;}
  const state=scenarios.get(kind),write=/必须执行 node ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")/.exec(prompt);assert.ok(state&&write);
  const binding=JSON.parse(readFileSync(JSON.parse(write[2]),'utf8')),task=(await(await fetch(workbench+'/api/tasks/'+binding.taskId)).json()).task;
  const phase=task.runs.length===1?'acquire':'recover',stepKey=binding.terminalId;
  if(!state.steps.has(stepKey)){
    const tool=body.tools.find(t=>t.name==='pwsh');assert.ok(tool,'宿主必须提供原生pwsh工具');state.steps.add(stepKey);
    const quote=v=>"'"+v.replaceAll("'","''")+"'";
    sse(res,{name:tool.name,input:{command:`& ${quote(process.execPath)} ${quote(helper)} ${phase} ${quote(JSON.parse(write[2]))}`,description:'保存锁异常恢复验收',timeoutMs:60000}});return;
  }
  const meta=readMeta(binding.terminalId);assert.ok(existsSync(meta.writeGuard.leasePath),'必须由原生工具先取得锁，才允许制造模型故障');
  if(task.runs.length>1){assert.ok(existsSync(meta.deliveryPath),'恢复工具必须实际写库并交付，不能仅回复成功');sse(res);return;}
  assert.equal(existsSync(meta.deliveryPath),false,'禁止Agent回传failed来代替模型错误');
  state.injected++;state.oldMeta=meta;state.lockBeforeFault=true;
  if(kind==='network'){req.socket.destroy();return;}
  const status=kind==='key'?401:402;res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify({type:'error',error:{type:kind==='key'?'authentication_error':'invalid_request_error',code:kind==='key'?'invalid_api_key':'insufficient_balance',message:kind==='key'?'Invalid API key (controlled transport fault)':'Insufficient balance (controlled transport fault)'}}));
}catch(error){handlerError=error;if(!res.headersSent)res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'acceptance handler failed'}}));}});
await new Promise(done=>model.listen(0,'127.0.0.1',done));
const portProbe=createServer();await new Promise(done=>portProbe.listen(0,'127.0.0.1',done));const port=portProbe.address().port;await new Promise(done=>portProbe.close(done));
writeFileSync(resolve(dir,'patch.json'),JSON.stringify([{id:'dsh-industry-research',config:{dataDir:resolve(dir,'workbench')}},{id:'agent-default-model',config:{provider:'deepseek-official',model:'deepseek-flash'}},{id:'llm-deepseek-account',disabled:true},{id:'llm-deepseek',config:{baseURL:`http://127.0.0.1:${model.address().port}`,apiKeyEnv:'DSH_MODEL_FAILURE_KEY',retryPolicy:{mode:'normal',maxRetries:0}}}]));
const cli=resolve(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js');
child=spawn(process.execPath,['--expose-internals',cli,'--profile','model-failure','--patch',resolve(dir,'patch.json'),'--no-open','--port',String(port)],{env:{...process.env,DSH_HOME:dir,LARK_CLI_COMMAND:cliShim,MODEL_FAILURE_CLOUD_CONFIG:configFile,DSH_MODEL_FAILURE_KEY:'sk-'+ 'a'.repeat(32)},stdio:['ignore','pipe','pipe'],windowsHide:true});
child.stdout.on('data',x=>{log=(log+x).slice(-20000);});child.stderr.on('data',x=>{log=(log+x).slice(-20000);});
async function until(fn,timeout=60000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(handlerError)throw handlerError;const v=await fn();if(v)return v;if(child.exitCode!==null)throw new Error('DSH宿主退出');await new Promise(r=>setTimeout(r,200));}throw new Error('模型异常验收等待超时');}
async function json(path,body){const response=await fetch(workbench+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;}
try{
  const status=await until(async()=>{try{const s=await(await fetch(`http://127.0.0.1:${port}/industry-research/status`)).json();if(s.state==='error')throw new Error(s.message);return s.state==='ready'&&s;}catch(e){if(e instanceof TypeError||e instanceof SyntaxError)return;throw e;}});workbench=status.url;
  const response=await fetch(workbench+'/api/feishu-settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({rootName:'验收根目录',folderUrl:'https://example.feishu.cn/drive/folder/'+cloud.rootToken})});assert.equal(response.status,200);
  await(await fetch(workbench+'/api/industry/library?refresh=true')).json();
  browser=await chromium.launch({headless:true});page=await browser.newPage();await page.goto(workbench);await page.getByRole('tab',{name:'历史 AI 任务'}).click();
  for(const kind of ['key','quota','network']){
    const state={steps:new Set(),injected:0};scenarios.set(kind,state);
    const task=await json('/api/industry/tasks',{companies:['后摩智能'],dimensions:['主营业务及产品'],sources:['官网核验'],requirements:'MODEL_FAILURE_'+kind});
    const failed=await until(async()=>{const t=(await json('/api/tasks/'+task.id)).task;return t.status==='failed'&&t;});
    const meta=state.oldMeta;assert.ok(meta&&state.lockBeforeFault);assert.equal(existsSync(meta.deliveryPath),false);console.log('Observed '+kind+': host failed after tool-acquired lock, no receipt');
    const ended=readMeta(meta.id);assert.equal(ended.lastTurnReason,'error');
    assert.equal(ended.lastTurnErrorCode,{key:'AUTH',quota:'QUOTA',network:'TRANSPORT'}[kind]);
    const card=page.locator('#task-card-'+task.id);await card.getByText('失败',{exact:true}).waitFor();
    const lease=JSON.parse(readFileSync(meta.writeGuard.leasePath,'utf8'));
    const stale=await fetch(workbench+'/api/tasks/'+task.id+'/write-operation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:meta.deliveryRequestId,terminalId:meta.id,leaseId:lease.leaseId,action:'begin',operationId:randomUUID()})});assert.equal(stale.status,409);
    // Independently prove that another task can acquire this resource, rather
    // than inferring lock release from a failed task label.
    const probe=await json('/api/industry/tasks',{companies:['后摩智能'],dimensions:['主营业务及产品'],sources:['官网核验'],requirements:'MODEL_FAILURE_'+kind});
    const probeFailed=await until(async()=>{const t=(await json('/api/tasks/'+probe.id)).task;return t.status==='failed'&&t;});assert.ok(probeFailed);assert.equal(state.oldMeta.taskId,probe.id,'独立任务也必须实际取得同一资料库的锁后才发生模型错误');
    await card.getByRole('button',{name:'重试',exact:true}).click();
    const done=await until(async()=>{const t=(await json('/api/tasks/'+task.id)).task;return t.status==='ready'&&t;},90000);
    assert.equal(done.publication.status,'published');assert.equal(done.error,null);assert.deepEqual(done.runs.map(r=>r.status),['failed','completed']);assert.equal(done.nativeSessionId,failed.nativeSessionId);
    await page.locator('.industry-heading').filter({hasText:'已完成'}).waitFor();
    await page.getByRole('button',{name:'← 返回工作台',exact:true}).click();
    await page.getByRole('tab',{name:'历史 AI 任务'}).click();
    await card.getByText('已完成',{exact:true}).waitFor();assert.equal(await card.getByRole('button',{name:'重试',exact:true}).count(),0);
    const fresh=readMeta(done.terminalId),newLease=JSON.parse(readFileSync(fresh.writeGuard.leasePath,'utf8'));assert.notEqual(newLease.leaseId,lease.leaseId);
    const writes=JSON.parse(readFileSync(resolve(fresh.cwd,'model-failure-result-'+fresh.id+'.json'),'utf8'));
    results.push({kind,lockBeforeFault:true,agentFailedReceipt:false,hostError:ended.lastTurnErrorCode,modelFailureRequests:state.injected,staleWriteStatus:stale.status,independentTaskAcquired:true,newLease:true,sameSession:true,status:done.status,publication:done.publication.status,ui:'已完成',writes});
    console.log('PASS '+kind+': model transport error after lock; no Agent failed receipt; released, retry wrote and UI completed');
  }
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify({at:new Date().toISOString(),packageVersion:JSON.parse(readFileSync(resolve(packageRoot,'package.json'),'utf8')).version,realDshHost:true,model:'controlled HTTP 401 / 402 / socket disconnect',storage:live?'real Feishu existing authorized documents':'persistent test storage',cases:results},null,2));
  console.log('Evidence: '+output);
}catch(error){if(page){console.error((await page.locator('body').innerText()).slice(-2200));}console.error(log.slice(-4000).replace(/([?&]token=)[^\s&]+/g,'$1[REDACTED]'));throw error;}
finally{
  await browser?.close();child?.kill('SIGTERM');if(child&&child.exitCode===null)await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);if(child?.exitCode===null)child.kill('SIGKILL');
  model.closeAllConnections();await new Promise(done=>model.close(done));
  if(resolve(dir).startsWith(resolve(tmpdir())+sep))rmSync(dir,{recursive:true,force:true});
}
