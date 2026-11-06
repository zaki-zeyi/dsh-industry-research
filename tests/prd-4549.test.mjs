import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { createApp } from '../server/app.mjs';
import { cloudPublications, publicationCacheKey, mergePublicationCards } from '../server/cloud-publications.mjs';
import { briefingPrompt, reportWindow } from '../server/briefing-prompt.mjs';

test('PRD4549 日报周报默认 Prompt 呈现公司维度、三种日期和无更新规则',()=>{
 for(const kind of ['daily','weekly']){
  const prompt=briefingPrompt({kind,companies:['后摩智能'],sources:['芯东西'],dimensions:['技术路线']},reportWindow(kind,new Date('2026-11-06T03:00:00Z')));
  for(const value of ['公司名称下按当前配置维度','披露日','事件发生日','入库日','原始来源链接',kind==='daily'?'本日无更新':'本周无更新'])assert.ok(prompt.includes(value));
 }
});

test('PRD4549 目录设置独立保存、校验路径并供下次配置读取',async()=>{
 const f=fixture(),server=createApp(f.service).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  const put=directoryName=>fetch(base+'/api/internal-materials/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({directoryName})});
  assert.equal((await put('访谈资料')).status,200);
  assert.equal((await(await fetch(base+'/api/config')).json()).internalDirectoryName,'访谈资料');
  assert.equal((await put('../private')).status,400);assert.equal(f.store.setting('internal-directory-name'),'访谈资料');
  assert.equal(f.store.list().length,0);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}
});

function setup(){const f=fixture();f.service.cloudOnly=true;f.service.setFeishuSettings({rootName:'行研工作台',folderUrl:'https://example.feishu.cn/drive/folder/RootFixture'});f.service.binding={applicationSnapshot:()=>({mode:'custom',appId:'cli_fixture123',profile:'fixture'})};return f;}
const doc=(name,url)=>({name,type:'docx',url,modified_time:'1793934000'});
const cli=files=>async(_command,args)=>({stdout:JSON.stringify({ok:true,data:{files:files[args[args.indexOf('--folder-token')+1]]??[],has_more:false}})});

test('PRD4549 云端日报按目录读取，不创建任务或通知，缓存与本机链接去重',async()=>{
 const f=setup();try{
  const run=cli({RootFixture:[{type:'folder',name:'日报',token:'daily'}],daily:[doc('日报 · 历史报告','https://example.feishu.cn/docx/RemoteDaily')]});
  const result=await cloudPublications(f.service,'daily',{refresh:true,run});
  assert.equal(result.items.length,1);assert.equal(result.items[0].remoteOnly,true);assert.equal(f.store.list().length,0);
  const merged=mergePublicationCards([{id:'local',publication:{url:result.items[0].publication.url}}],result.items);assert.equal(merged.length,1);assert.equal(merged[0].id,'local');
  const cached=await cloudPublications(f.service,'daily',{run:()=>{throw Error('must not poll CLI');}});assert.deepEqual(cached,result);
  await assert.rejects(cloudPublications(f.service,'daily',{refresh:true,run:async()=>{throw Error('network timeout');}}));
  assert.deepEqual(await cloudPublications(f.service,'daily'),result);
 }finally{await f.close();}
});

test('PRD4549 自定义内部目录发现逐字稿，账号切换隔离缓存',async()=>{
 const f=setup();try{
  f.store.saveSetting('internal-directory-name','访谈资料');
  const result=await cloudPublications(f.service,'internal',{refresh:true,run:cli({RootFixture:[{type:'folder',name:'访谈资料',token:'internal'}],internal:[{type:'folder',name:'逐字稿',token:'transcript'}],transcript:[doc('创始人访谈','https://example.feishu.cn/docx/Transcript')]})});
  assert.equal(result.items[0].internal.directoryName,'访谈资料');assert.equal(result.items[0].publication.sourceTitle,'创始人访谈');
  const root=f.service.feishuSettings();assert.notEqual(publicationCacheKey(root,{profile:'first'},'internal','访谈资料'),publicationCacheKey(root,{profile:'second'},'internal','访谈资料'));
  assert.notEqual(publicationCacheKey(root,{profile:'first'},'daily'),publicationCacheKey({...root,folderToken:'anotherRoot'},{profile:'first'},'daily'));
  f.service.binding.applicationSnapshot=()=>({mode:'custom',appId:'cli_other123',profile:'other'});
  assert.deepEqual((await cloudPublications(f.service,'internal')).items,[]);
 }finally{await f.close();}
});

test('PRD4549 同步失败 API 返回本地历史和错误，缺目录权限不阻断浏览本地记录',async()=>{
 const f=setup();const server=createApp(f.service,{publicationRun:async()=>{throw Error('network timeout');}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  f.store.save({id:'local-record',createdAt:'2026-11-06T00:00:00Z',direction:'本地历史日报',status:'ready',briefing:{kind:'daily'},publication:{status:'published',url:'https://example.feishu.cn/docx/Local'}});
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/briefings?kind=daily&refresh=true');
  assert.equal(response.status,200);const body=await response.json();assert.equal(body.items[0].id,'local-record');assert.ok(body.syncError);
  assert.equal(f.store.runtimeLogs({feishu:true})[0].event,'feishu.publications.read');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}
});

test('PRD4549 飞书分页全部读取，失败和同步时切换应用不污染缓存',async()=>{
 const f=setup();try{
  let calls=0;
  const run=async(_command,args)=>{calls++;const folder=args[args.indexOf('--folder-token')+1];return{stdout:JSON.stringify({ok:true,data:folder==='RootFixture'?{files:[{type:'folder',name:'周报',token:'weekly'}],has_more:false}:args.includes('--page-token')?{files:[doc('周报二','https://example.feishu.cn/docx/Two')],has_more:false}:{files:[doc('周报一','https://example.feishu.cn/docx/One')],has_more:true,next_page_token:'page2'}})};};
  assert.equal((await cloudPublications(f.service,'weekly',{refresh:true,run})).items.length,2);assert.equal(calls,3);
  await assert.rejects(cloudPublications(f.service,'daily',{refresh:true,run:async(...args)=>{const value=await run(...args);f.service.binding.applicationSnapshot=()=>({profile:'changed'});return value;}}),/变化/);
 }finally{await f.close();}
});

test('PRD4549 内部资料 API 真正合并云端逐字稿，不只是模块可调用',async()=>{
 const f=setup();const server=createApp(f.service,{publicationRun:cli({RootFixture:[{type:'folder',name:'内部资料',token:'internal'}],internal:[{type:'folder',name:'逐字稿',token:'transcript'}],transcript:[doc('云端访谈','https://example.feishu.cn/docx/Interview')]})}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/internal-materials?refresh=true');
  assert.equal(response.status,200);const body=await response.json();assert.equal(body.items.length,1);assert.equal(body.items[0].publication.sourceTitle,'云端访谈');assert.equal(body.items[0].remoteOnly,true);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}
});
