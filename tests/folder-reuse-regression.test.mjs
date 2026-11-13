import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fixture} from './helpers.mjs';
import {cloudPublications} from '../server/cloud-publications.mjs';
import {preferredFolder,matchingFolders} from '../server/folder-identity.mjs';
import {prepareLarkAgent} from '../server/lark-agent-files.mjs';
const folder=(name,token,created_time)=>({name,token,type:'folder',created_time});
const doc=token=>({name:token,type:'docx',token,url:'https://tenant.feishu.cn/docx/'+token});

test('复用规则不依赖列表顺序，优先已有token，其次创建时间，重复分页token去重',()=>{
 const files=[folder(' 日报 ','New',200),folder('日报','Old',100),folder('日报','Old',100)];
 assert.equal(preferredFolder(files,'日报').token,'Old');assert.equal(preferredFolder([...files].reverse(),'日报').token,'Old');
 assert.equal(preferredFolder(files,'日报','New').token,'New');assert.equal(matchingFolders(files,'日报').length,2);
 assert.throws(()=>preferredFolder([{name:'日报',type:'folder'}],'日报'),/缺少有效 ID/);
});

for(const kind of ['daily','weekly','internal'])test(kind+'：历史重复目录全部读取，刷新不写入、不新建、不丢报告',async()=>{
 const f=fixture(),name={daily:'日报',weekly:'周报',internal:'内部资料'}[kind];
 const lists={Root:[folder(name,'A'),folder(name,'B')],A:kind==='internal'?[folder('逐字稿','T1')]:[doc('One'),doc('Shared')],B:kind==='internal'?[folder('逐字稿','T2')]:[doc('Two'),doc('Shared')],T1:[doc('One'),doc('Shared')],T2:[doc('Two'),doc('Shared')]};
 f.service.cloudOnly=true;f.service.binding={applicationSnapshot:()=>({profile:'test'}),command:'/fake/cli'};f.service.feishuSettings=()=>({rootName:'行研工作台',folderToken:'Root'});
 const calls=[];const run=async(command,args)=>{assert.equal(command,'/fake/cli');assert.ok(args.includes('list'));calls.push(args);return{stdout:JSON.stringify({ok:true,data:{files:lists[args[args.indexOf('--folder-token')+1]],has_more:false}})};};
 try{
  const result=await cloudPublications(f.service,kind,{refresh:true,run});assert.equal(result.items.length,3);
  lists.Root.reverse();assert.deepEqual(new Set((await cloudPublications(f.service,kind,{refresh:true,run})).items.map(t=>t.publication.url)),new Set(result.items.map(t=>t.publication.url)));
  const saved=await cloudPublications(f.service,kind);const before=JSON.stringify(saved);
  await assert.rejects(cloudPublications(f.service,kind,{refresh:true,run:async()=>{throw Error('network unavailable')}}));
  assert.equal(JSON.stringify(await cloudPublications(f.service,kind)),before);assert.ok(calls.length>=6);
 }finally{await f.close();}
});

test('原生会话不能绕过保存锁自行创建目录，旧手动上传保留兼容',async()=>{
 const f=fixture(),cli=resolve(f.dir,'fake-cli.mjs');
 writeFileSync(cli,"import {writeFileSync} from 'node:fs';writeFileSync(new URL('./executed',import.meta.url),'yes');console.log('ok');");
 const meta={cwd:f.dir,workflow:'cloud-only'};prepareLarkAgent(meta,cli);
 const run=promisify(execFile);
 try{
  for(const args of [['drive','+create-folder','--name','日报'],['--profile','test','drive','files','create_folder','--name','日报']]){
   await assert.rejects(run(process.execPath,[meta.larkClientPath,...args]),e=>e.code===1&&e.stderr.includes('PLATFORM_MANAGED_FOLDERS'));
  }
  const {existsSync}=await import('node:fs');assert.equal(existsSync(resolve(f.dir,'executed')),false);
  await run(process.execPath,[meta.larkClientPath,'drive','files','list']);assert.equal(readFileSync(resolve(f.dir,'executed'),'utf8'),'yes');
  meta.workflow='manual-upload';prepareLarkAgent(meta,cli);await run(process.execPath,[meta.larkClientPath,'drive','+create-folder']);
 }finally{await f.close();}
});
