// Invoked by a genuine DSH model tool_use, never from the model HTTP handler.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {parseLibraryManifest} from '../../server/industry.mjs';
const [phase,configPath]=process.argv.slice(2),config=JSON.parse(readFileSync(configPath,'utf8'));
const endpoint=JSON.parse(readFileSync(config.endpointFile,'utf8')).url;
const before=(await(await fetch(endpoint+'/api/tasks/'+config.taskId)).json()).task;
assert.equal(before.status,'running');
execFileSync(process.execPath,[resolve(dirname(configPath),'cloud-write-client.mjs'),configPath],{timeout:60000,windowsHide:true});
if(phase==='acquire'){console.log(JSON.stringify({acquired:true,noDeliveryReceiptWritten:true}));}
else{
  const task=(await(await fetch(endpoint+'/api/tasks/'+config.taskId)).json()).task;
  const cli=resolve(dirname(configPath),`lark-${config.terminalId}`,'lark-agent-client.mjs');
  function run(args){const value=JSON.parse(execFileSync(process.execPath,[cli,...args,'--as','user'],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,windowsHide:true}));assert.equal(value.ok,true);return value.data;}
  const target=task.industryLibrary.companies.find(c=>c.name==='后摩智能'),index=task.industryLibrary.manifestUrl;
  assert.ok(target?.url&&index);
  const company=run(['docs','+fetch','--doc',target.url]).document;
  const pattern=[...company.content.matchAll(/>([^<>]*?(?:再次核验于|核验日期[：:] ?)\d{4}-\d{2}-\d{2}[^<>]*)</g)].map(m=>m[1]).find(text=>company.content.split(text).length-1===1);
  assert.ok(pattern,'必须有唯一的既有核验标注，禁止插入测试段落或跨段替换');
  const stamp=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date());
  const replacement=pattern.replace(/(再次核验于|核验日期[：:] ?)\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?/,(_,label)=>label+stamp);
  run(['docs','+update','--doc',target.url,'--command','str_replace','--pattern',pattern,'--content',replacement]);
  const checked=run(['docs','+fetch','--doc',target.url]).document;assert.ok(checked.content.includes(replacement));assert.ok(checked.revision_id>company.revision_id);
  const oldIndex=run(['docs','+fetch','--doc',index,'--doc-format','markdown']).document;
  const entries=parseLibraryManifest(oldIndex.content),entry=entries.find(c=>c.name===target.name);assert.ok(entry);
  // Match the literal original timestamp, preserving its formatting and every
  // other company's data. Refuse ambiguous timestamps rather than overwrite.
  const original=JSON.parse(oldIndex.content.slice(oldIndex.content.indexOf('{'),oldIndex.content.lastIndexOf('}')+1)).companies.find(c=>c.name===target.name).updatedAt;
  assert.equal(oldIndex.content.split(original).length-1,1,'索引时间戳必须唯一');
  run(['docs','+update','--doc',index,'--command','str_replace','--pattern',original,'--content',new Date().toISOString()]);
  const checkedIndex=run(['docs','+fetch','--doc',index,'--doc-format','markdown']).document;
  const after=parseLibraryManifest(checkedIndex.content);
  assert.equal(after.length,entries.length);for(const c of entries){const next=after.find(v=>v.name===c.name);assert.equal(next?.url,c.url);if(c.name!==target.name)assert.deepEqual(next,c);}
  assert.ok(checkedIndex.revision_id>oldIndex.revision_id);
  const receipt={requestId:config.requestId,status:'published',folderToken:task.feishuRoot.folderToken,libraryFolderToken:task.industryLibrary.folderToken,manifestUrl:index,url:target.url,companies:[{name:target.name,url:target.url,dimensions:target.dimensions,added:0,conflicts:target.conflicts??0}]};
  const metaFile=resolve(dirname(configPath),'model-failure-result-'+config.terminalId+'.json');
  writeFileSync(metaFile,JSON.stringify({companyBefore:company.revision_id,companyAfter:checked.revision_id,indexBefore:oldIndex.revision_id,indexAfter:checkedIndex.revision_id,companyCount:after.length,otherCompaniesPreserved:true}));
  const delivery=resolve(dirname(configPath),'delivery-'+config.requestId+'.json');writeFileSync(delivery+'.tmp',JSON.stringify(receipt));renameSync(delivery+'.tmp',delivery);
  console.log(JSON.stringify({writtenAndReadBack:true,publishedReceiptWritten:true}));
}
