// Test-only directory adapter. With --live-feishu, docs/auth go to the user's
// existing CLI profile; no credential is read, copied, changed or registered.
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const config=JSON.parse(readFileSync(process.env.MODEL_FAILURE_CLOUD_CONFIG,'utf8'));
const args=process.argv.slice(2),at=name=>args[args.indexOf(name)+1];
if(args.includes('files')&&args.includes('list')){
  const parent=at('--folder-token');
  const files=parent===config.rootToken?[{name:'全量信息库',type:'folder',token:config.libraryToken}]
    :parent===config.libraryToken?[{name:'公司索引',type:'docx',token:config.indexToken,url:config.indexUrl}]:[];
  console.log(JSON.stringify({ok:true,data:{files,has_more:false}}));
}else if(config.live){
  if(!args.includes('docs')&&!args.includes('auth'))throw new Error('验收仅允许现有文档读写及身份读取');
  process.stdout.write(execFileSync(config.command,[...(config.commandArgs??[]),'--profile',config.profile,...args],{encoding:'utf8',input:readFileSync(0),timeout:60000,maxBuffer:4*1024*1024,windowsHide:true}));
}else if(args.includes('auth')){
  console.log(JSON.stringify({appId:'cli_failureFixture',identities:{user:{available:true,verified:true,openId:'ou_fixture',userName:'验收',scope:config.scopes.join(' ')}}}));
}else if(args.includes('+fetch')||args.includes('+update')){
  const state=JSON.parse(readFileSync(config.stateFile,'utf8')),token=at('--doc').split('/').at(-1),doc=state[token];
  if(!doc)throw new Error('未知验收文档');
  if(args.includes('+update')){
    if(at('--command')!=='str_replace')throw new Error('只允许精确替换');
    const pattern=at('--pattern');if(!doc.content.includes(pattern))throw new Error('未匹配原内容');
    doc.content=doc.content.split(pattern).join(at('--content'));doc.revision_id++;state.writes++;
    writeFileSync(config.stateFile,JSON.stringify(state));
  }
  console.log(JSON.stringify({ok:true,data:{document:doc,result:'success'}}));
}else throw new Error('不支持的验收CLI操作');
