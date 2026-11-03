import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { request } from 'node:http';
import { createApp } from '../server/app.mjs';
import { fixture, until } from './helpers.mjs';
import { prepareInternalMaterial, MAX_LOCAL_UPLOAD_BYTES } from '../server/internal-materials.mjs';
async function setup() {
 const f=fixture(),uploadDir=join(f.dir,'imports'),server=createApp(f.service,{uploadDir}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 return {...f,uploadDir,base:'http://127.0.0.1:'+server.address().port,async finish(){server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}};
}
test('PRD1554 文件选择器导入实际字节、保留中文文件名并交付可读取路径',async()=>{
 const f=await setup();try {
  const body=Buffer.from('录音原始数据\n逐字稿验证');
  const response=await fetch(f.base+'/api/internal-material-files?name='+encodeURIComponent('访谈 记录.txt'),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body});assert.equal(response.status,201);
  const value=await response.json();assert.equal(value.name,'访谈 记录.txt');assert.deepEqual(readFileSync(value.source),body);
  const input=prepareInternalMaterial({sourceType:'local',source:value.source});assert.equal(input.internal.fileSize,body.length);assert.equal(input.internal.sourceLabel,'访谈 记录.txt');
 }finally{await f.finish();}
});
test('PRD1554 拒绝越界文件名、空文件、错误内容类型和跨站导入',async()=>{
 const f=await setup();try {
  const post=(name,body='data',headers={})=>fetch(f.base+'/api/internal-material-files?name='+encodeURIComponent(name),{method:'POST',headers:{'Content-Type':'application/octet-stream',...headers},body});
  for(const name of ['../escape.txt','..','a/b.txt','a\\b.txt'])assert.equal((await post(name)).status,400);
  assert.equal((await post('empty.txt','')).status,400);
  assert.equal((await post('bad.txt','data',{'Content-Type':'text/plain'})).status,415);
  assert.equal((await post('bad.txt','data',OriginHeader())).status,403);
  assert.deepEqual(readdirSync(f.uploadDir),[]);
 }finally{await f.finish();}
 function OriginHeader(){return {Origin:'https://evil.example'};}
});
test('PRD1554 超过100MB的声明被拒绝，不写入文件',async()=>{
 const f=await setup();try {
  const status=await new Promise((resolve,reject)=>{const req=request(f.base+'/api/internal-material-files?name=large.wav',{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':MAX_LOCAL_UPLOAD_BYTES+1}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(status,413);assert.ok(!existsSync(f.uploadDir));
 }finally{await f.finish();}
});
test('PRD1554 导入中断清除未完成文件，不保留损坏来源',async()=>{
 const f=await setup();try {
  const req=request(f.base+'/api/internal-material-files?name=aborted.wav',{method:'POST',headers:{'Content-Type':'application/octet-stream'} });req.on('error',()=>{});req.write(Buffer.alloc(4096));
  await until(()=>existsSync(f.uploadDir)&&readdirSync(f.uploadDir).length>0);req.destroy();
  await until(()=>readdirSync(f.uploadDir).length===0);
 }finally{await f.finish();}
});

test('PRD1554 无Content-Length分块超限返回413并清理临时文件',async()=>{
 const f=await setup();try {
  const chunk=Buffer.alloc(1024*1024);
  const response=await fetch(f.base+'/api/internal-material-files?name=chunked.wav',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Readable.from((function*(){for(let i=0;i<101;i++)yield chunk;})()),duplex:'half'});
  assert.equal(response.status,413);assert.match((await response.json()).error,/100 MB/);
  assert.deepEqual(readdirSync(f.uploadDir),[]);
 }finally{await f.finish();}
});
