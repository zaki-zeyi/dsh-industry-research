// Isolated native-host fixture: no real model, OAuth, CLI or Feishu writes.
import { startRuntime } from '../server/runtime.mjs';
import { mockHost } from '../tests/fixtures/fake-native-host.mjs';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { library } from '../server/industry.mjs';
import { analysisLibrary } from '../server/analysis.mjs';
import { createHash } from 'node:crypto';
const dir=mkdtempSync(resolve(tmpdir(),'industry-e2e-')),host=mockHost();let bound=true;
const binding={applicationSnapshot:()=>({mode:'default'}),async status(){return{bound,authenticated:bound,applicationConfigured:true};},async requireBound(){if(!bound)throw Object.assign(new Error('请先绑定飞书'),{status:428});},registration:{snapshot:()=>({status:'idle'})},close(){}};
const analysisRun=async()=>{const root=runtime.service.feishuSettings(),app=runtime.service.binding?.applicationSnapshot?.()??{mode:'default'};return{stdout:JSON.stringify({ok:true,data:{document:{content:JSON.stringify({reports:analysisLibrary(runtime.service.store,root,app).reports})}}})};};
const runtime=await startRuntime({port:3099,dataDir:dir,env:{RESEARCH_MODE:'native'},host,binding,analysisRun,libraryRun:async()=>({stdout:JSON.stringify({ok:true,data:{document:{content:JSON.stringify({companies:library(runtime.service.store,runtime.service.feishuSettings()).companies.map(c=>({...c,updatedAt:'2026-11-02T19:41:58+08:00'}))})}}})})});
const attempts=new Map();
host.sessionController.prompt=async request=>{
 host.emit(request.sessionId,'turn/start');const path=/请读取 (.+)，按照/.exec(request.content[0].text)?.[1];if(!path)return {accepted:true};
 const p=readFileSync(path,'utf8'),config=JSON.parse(/以下 JSON 是[^\n]*\n(.+)/.exec(p)[1]);
 const count=(attempts.get(request.sessionId)??0)+1;attempts.set(request.sessionId,count);
 setTimeout(()=>{const requestId=/本次 requestId 固定为 ([a-f0-9-]+)/.exec(p)[1],deliveryPath=/原子更新 (.+)，本次 requestId/.exec(p)[1];
  let receipt;
  if(config.analysis){const reportUrl='https://example.feishu.cn/docx/AnalysisReportFixture';receipt={requestId,status:'published',folderToken:'RootFixture',analysisFolderToken:'AnalysisFixture',analysisManifestUrl:'https://example.feishu.cn/docx/AnalysisManifestFixture',url:reportUrl,report:{title:'友商分析 · '+config.analysis.companies.join(' × '),url:reportUrl,companies:config.analysis.companies,dimensions:config.analysis.dimensions,updatedAt:'2026-11-03T18:00:00+08:00',insufficient:[]}};}
  else{const partial=config.companies.includes('失败验收公司')&&count===1;receipt={requestId,status:partial?'failed':'published',folderToken:'RootFixture',libraryFolderToken:'LibraryFixture',manifestUrl:'https://example.feishu.cn/docx/FixtureManifest',url:'https://example.feishu.cn/docx/FixtureDoc',...(partial?{error:'测试信源不可用，已保留完成内容'}:{}),companies:config.companies.slice(0,partial?1:undefined).map(name=>({name,url:'https://example.feishu.cn/docx/'+createHash('sha256').update(name).digest('hex').slice(0,24),dimensions:config.dimensions,added:3,conflicts:name==='后摩智能'?1:0}))};}
  writeFileSync(deliveryPath,JSON.stringify(receipt));host.emit(request.sessionId,'turn/end',{kind:'completed'});},350);
 return{accepted:true};
};
async function stop(){await runtime.close();rmSync(dir,{recursive:true,force:true});process.exit(0);}process.on('SIGTERM',stop);process.on('SIGINT',stop);
