import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isHostFilePath, pickHostFile } from '../src/host-file-picker.mjs';
import { createApp } from '../server/app.mjs';
import { fixture } from './helpers.mjs';
import { prepareInternalMaterial } from '../server/internal-materials.mjs';
function host(bridge) {
 let loaded,receive,pos=0;const hooks=[],effects=[],replies=[],inputs=[],rows=[];
 const frameWindow={postMessage(value,origin){replies.push({value,origin});}};
 const React={createElement(type,props,...children){return{type,props:props??{},children};},useRef(value){const at=pos++;hooks[at]??={current:value};return hooks[at];},useState(value){const at=pos++;if(!(at in hooks))hooks[at]=value?.state==='starting'?{state:'ready',url:'http://127.0.0.1:4000'}:value;return[hooks[at],v=>{hooks[at]=v;}];},useEffect(fn){effects.push(fn);}};
 const window={__DSH_HOST_PATHS__:bridge,location:{origin:'dsh-app://app',protocol:'dsh-app:'},__ModuleLoader__:{load(v){loaded=v;}},addEventListener(_n,fn){receive=fn;},removeEventListener(){},document:{body:{append(){}},createElement(){const input={style:{},events:{},removed:false,addEventListener(n,f){this.events[n]=f;},remove(){this.removed=true;},click(){this.clicked=true;}};inputs.push(input);return input;}}};
 runInNewContext(readFileSync(new URL('../plugin/client.js',import.meta.url),'utf8'),{window,Intl});loaded.factory(()=>React).apply({slots:{inject(_n,f){f();},register(options,component){rows.push({options,component});}}});
 const tree=rows.find(v=>v.options.name==='main').component({});
 function find(t){if(t?.type==='iframe')return t;for(const c of t?.children??[]){const x=find(c);if(x)return x;}}
 find(tree).props.ref.current={contentWindow:frameWindow};const cleanup=effects[1]();
 const id='12345678-1234-4234-8234-123456789abc';
 return{inputs,replies,cleanup,id,send(data={},options={}){return receive({origin:'http://127.0.0.1:4000',source:frameWindow,...options,data:{type:'industry-research:pick-file',requestId:id,...data}});}};
}
test('PRD1622 官方宿主pathFor返回原始完整路径，取消和卸载清理选择器',async()=>{
 let observed;const path='C:\\资料\\原始访谈.wav',f=host({pathFor(file){observed=file;return path;}});
 await f.send();const input=f.inputs[0],file={name:'原始访谈.wav',size:10};input.files=[file];input.events.change();
 assert.equal(observed,file);assert.equal(f.replies[0].value.path,path);assert.equal(f.replies[0].value.size,10);assert.equal(input.removed,true);
 await f.send();f.inputs[1].events.cancel();assert.equal(f.replies[1].value.cancelled,true);
 await f.send();f.cleanup();assert.equal(f.inputs[2].removed,true);
});
test('PRD1622 宿主拒绝伪造来源、虚拟路径及无桥接环境，不读取文件内容',async()=>{
 const f=host({pathFor:()=> 'C:\\fakepath\\a.txt'});await f.send({}, {origin:'https://evil.example'});await f.send({}, {source:{}});assert.equal(f.inputs.length,0);
 await f.send();f.inputs[0].files=[{size:1}];f.inputs[0].events.change();assert.match(f.replies[0].value.error,/完整路径/);f.cleanup();
 const web=host();await web.send();assert.equal(web.inputs.length,0);assert.match(web.replies[0].value.error,/网页版/);web.cleanup();
});
test('PRD1622 路径校验接受Windows/macOS/UNC原始绝对路径，拒绝虚拟和相对路径',()=>{
 for(const p of ['C:\\资料\\file.wav','/Users/user/file.wav','\\\\server\\share\\file.wav'])assert.equal(isHostFilePath(p),true);
 for(const p of ['a.wav','C:\\fakepath\\file.wav','file:///tmp/a','/tmp/a\n'])assert.equal(isHostFilePath(p),false);
 for(const source of ['relative.wav','C:\\fakepath\\file.wav'])assert.throws(()=>prepareInternalMaterial({sourceType:'local',source}),/原始完整路径/);
});
test('PRD1622 子页面只接受匹配宿主与请求的路径回复，取消后迟到结果无效',async()=>{
 const old={window:globalThis.window,document:globalThis.document,location:globalThis.location};
 const listeners=new Set(),messages=[],parent={postMessage(value){messages.push(value);}};
 globalThis.window={parent,addEventListener(_n,fn){listeners.add(fn);},removeEventListener(_n,fn){listeners.delete(fn);}};globalThis.document={referrer:'http://127.0.0.1:3090/'};globalThis.location={search:''};
 const emit=(data,source=parent,origin='http://127.0.0.1:3090')=>{for(const f of listeners)f({source,origin,data});};
 try{
  const promise=pickHostFile(),id=messages[0].requestId;emit({type:'industry-research:file-result',requestId:id,path:'/tmp/evil',size:1},{},'https://evil.example');assert.equal(listeners.size,1);
  emit({type:'industry-research:file-result',requestId:id,path:'/tmp/original.wav',size:12});assert.deepEqual(await promise,{path:'/tmp/original.wav',size:12});assert.equal(listeners.size,0);
  const c=new AbortController(),cancelled=pickHostFile({signal:c.signal});c.abort();await assert.rejects(cancelled,/取消/);assert.equal(listeners.size,0);assert.equal(messages.at(-1).type,'industry-research:cancel-file-picker');
 }finally{Object.assign(globalThis,old);}
});
test('PRD1622 删除二进制复制接口，旧接口返回404',async()=>{
 const f=fixture(),server=createApp(f.service).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/internal-material-files?name=file.wav',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:'data'});assert.equal(response.status,404);}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}
});
