import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { createApp } from '../server/app.mjs';
import { internalFolderKey, internalMaterialCloudPrompt, prepareInternalMaterial } from '../server/internal-materials.mjs';
import { library, mergeCompanyDelivery } from '../server/industry.mjs';
import { agentDeliverySchema } from '../server/agent-delivery.mjs';
const input = directoryName => prepareInternalMaterial({sourceType:'url',source:'https://example.com/interview.mp4',directoryName});
const receipt = () => ({status:'published',folderToken:'RootToken',materialFolderToken:'MaterialToken',reportFolderToken:'TranscriptToken',minutesFolderToken:'MinutesToken',sourceFolderToken:'SourceToken',url:'https://example.feishu.cn/docx/Transcript',minutesUrl:'https://example.feishu.cn/docx/Minutes',companies:[]});
function task(directoryName='内部资料') { return {...input(directoryName), id:'fixture',feishuRoot:{rootName:'研究',folderToken:'RootToken'},feishuApp:{mode:'default'}}; }

test('PRD1534 缺少会议纪要不能完成，已交付逐字稿与目录保留供重试',async()=>{
 const f=fixture();try {
  const t=task(),r=receipt();delete r.minutesUrl;
  assert.throws(()=>f.service.rememberInternalMaterial(t,r),/尚未完成/);
  assert.equal(t.publication.status,'publishing');assert.equal(t.publication.url,r.url);
  assert.equal(f.store.setting(internalFolderKey(t)).materialFolderToken,r.materialFolderToken);
  const prompt=internalMaterialCloudPrompt(t,{deliveryPath:'delivery',deliveryRequestId:'request'});
  assert.ok(prompt.includes(r.url));
  assert.throws(()=>f.service.rememberInternalMaterial(t,{...receipt(),minutesUrl:r.url}),/尚未完成/);
  f.service.rememberInternalMaterial(t,receipt());
  assert.equal(t.internalFolders.minutesFolderToken,'MinutesToken');
  assert.throws(()=>f.service.rememberInternalMaterial(t,{...receipt(),materialFolderToken:'WrongToken'}),/不一致/);
 }finally{await f.close();}
});

test('PRD1534 自定义目录持久化，任务快照与不同目录缓存隔离',async()=>{
 const f=fixture(),server=createApp(f.service).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 try {
  const post=body=>fetch(base+'/api/internal-materials',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const a=await post({sourceType:'url',source:'https://example.com/a',directoryName:'访谈档案'});assert.equal(a.status,202);
  const created=await a.json();assert.equal(created.internal.directoryName,'访谈档案');assert.ok(created.internal.research.companies.includes('后摩智能'));
  const b=await(await post({sourceType:'url',source:'https://example.com/b'})).json();assert.equal(b.internal.directoryName,'访谈档案');
  assert.equal((await(await fetch(base+'/api/config')).json()).internalDirectoryName,'访谈档案');
  assert.equal((await post({sourceType:'url',source:'https://example.com/a',directoryName:'../错误'})).status,400);
  assert.notEqual(internalFolderKey(task('目录一')),internalFolderKey(task('目录二')));
  const t=task('目录一');f.service.rememberInternalMaterial(t,receipt());
  assert.equal(f.store.setting(internalFolderKey(task('目录二'))),null);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}
});

test('PRD1534 内部资料增量更新原公司文档，拒绝重复文档和未配置公司',async()=>{
 const f=fixture();try {
  const t=task();t.internal.research={companies:['后摩智能'],dimensions:['融资']};
  const c={name:'后摩智能',url:'https://example.feishu.cn/docx/Company',dimensions:['融资'],added:1,conflicts:0};
  const r={...receipt(),libraryFolderToken:'LibraryToken',manifestUrl:'https://example.feishu.cn/docx/Manifest',companies:[c]};
  f.service.rememberInternalMaterial(t,r);mergeCompanyDelivery(f.store,t,r);mergeCompanyDelivery(f.store,t,r);
  assert.equal(library(f.store,t.feishuRoot,t.feishuApp).companies.length,1);
  assert.equal(library(f.store,t.feishuRoot,t.feishuApp).companies[0].url,c.url);
  assert.throws(()=>mergeCompanyDelivery(f.store,t,{...r,companies:[{...c,url:'https://example.feishu.cn/docx/Duplicate'}]}),/禁止重复/);
  assert.throws(()=>mergeCompanyDelivery(f.store,t,{...r,companies:[{...c,name:'未配置公司'}]}),/未请求/);
  assert.throws(()=>f.service.rememberInternalMaterial(t,{...r,manifestUrl:undefined}),/增量同步/);
 }finally{await f.close();}
});

test('PRD1534 无公司命中仍交付双文档，缺原始上传链接与非法纪要链接不能成功',async()=>{
 const f=fixture();try {
  const t=task(),source=t.internal.source,research=t.internal.research;
  f.service.rememberInternalMaterial(t,{...receipt(),sourceTitle:'后摩智能项之初：硅基算力会改变我们的生活吗？'});
  assert.equal(t.internal.sourceLabel,'后摩智能项之初：硅基算力会改变我们的生活吗？');
  assert.equal(t.internal.source,source);
  assert.deepEqual(t.internal.research,research);
  assert.equal(library(f.store,t.feishuRoot,t.feishuApp).companies.length,0);
  t.internal.uploadEligible=true;assert.throws(()=>f.service.rememberInternalMaterial(t,receipt()),/尚未上传/);
  assert.equal(agentDeliverySchema.safeParse({...receipt(),minutesUrl:'https://evil.example/docx/Test'}).success,false);
  assert.equal(agentDeliverySchema.safeParse({...receipt(),status:'failed',error:'网络中断'}).data.url,receipt().url);
 }finally{await f.close();}
});
