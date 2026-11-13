import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(fetch){
 let loaded,position=0,now=0,id=0;const hooks=[],effects=[],timers=new Map();
 const React={createElement(type,props,...children){return {type,props:props??{},children};},useRef(initial){const i=position++;hooks[i]??={current:initial};return hooks[i];},useState(initial){const i=position++;if(!(i in hooks))hooks[i]=initial;return [hooks[i],v=>{hooks[i]=typeof v==='function'?v(hooks[i]):v;}];},useEffect(fn){effects.push(fn);}};
 const window={__ModuleLoader__:{load(v){loaded=v;}},location:{origin:'http://127.0.0.1:3090',protocol:'http:'}};
 runInNewContext(readFileSync(new URL('../plugin/client.js',import.meta.url),'utf8'),{window,Intl,Date:{now:()=>now},AbortController,fetch,setTimeout(fn,ms){timers.set(++id,{fn,at:now+ms});return id;},clearTimeout(id){timers.delete(id);}});
 const rows=[];loaded.factory(()=>React).apply({slots:{inject(_n,fn){fn();},register(options,component){rows.push({options,component});}}});const Panel=rows.find(r=>r.options.name==='main').component;
 function render(){position=0;effects.length=0;return Panel({});}
 function find(tree,type){if(tree?.type===type)return tree;for(const child of tree?.children??[]){const x=find(child,type);if(x)return x;}}
 function text(tree){return typeof tree==='string'?tree:(tree?.children??[]).map(text).join('');}
 return {render,find,text,start(){render();return effects[0]();},async advance(ms){const end=now+ms;for(;;){const next=[...timers.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timers.delete(next[0]);now=next[1].at;next[1].fn();await flush();}now=end;await flush();},get timerCount(){return timers.size;}};
}
const ready=()=>({ok:true,status:200,json:async()=>({state:'ready',url:'http://127.0.0.1:3088'})});
test('回归：启动请求或JSON响应体挂起，8秒后提示超时；重试后恢复工作台',async()=>{
 for(const stalledBody of [false,true]){
  let retry=false,signal;const f=fixture(async(_path,opts)=>{signal=opts.signal;assert.equal(opts.cache,'no-store');assert.equal(opts.credentials,'same-origin');if(retry)return ready();return stalledBody?{ok:true,status:200,json:()=>new Promise(()=>{})}:new Promise(()=>{});});
  const stop=f.start();await flush();await f.advance(8000);const error=f.render();assert.equal(error.props.role,'alert');assert.match(f.text(error),/连接宿主超时/);assert.equal(signal.aborted,true);
  retry=true;f.find(error,'button').props.onClick();stop();const cleanup=f.start();await flush();assert.equal(f.find(f.render(),'iframe').props.src.startsWith('http://127.0.0.1:3088/'),true);cleanup();assert.equal(f.timerCount,0);
 }
});
test('回归：宿主持续starting，20秒后结束等待，不无限轮询',async()=>{
 let requests=0;const f=fixture(async()=>{requests++;return {ok:true,json:async()=>({state:'starting'})};});const stop=f.start();await flush();await f.advance(20000);assert.match(f.text(f.render()),/启动超时/);const count=requests;await f.advance(20000);assert.equal(requests,count);stop();
});
test('回归：授权失效、错误HTTP和异常状态显示可处理错误',async()=>{
 for(const response of [{status:401,ok:false},{status:403,ok:false},{status:503,ok:false},{status:200,ok:true,json:async()=>({unexpected:true})}]){
  const f=fixture(async()=>response),stop=f.start();await flush();const tree=f.render();assert.equal(tree.props.role,'alert');assert.ok(f.find(tree,'button'));assert.match(f.text(tree),response.status===401||response.status===403?/完整链接/:/无法连接|状态无效/);stop();
 }
});
test('回归：离开页面或重试后，迟到的旧请求不覆盖当前状态',async()=>{
 let finish,calls=0;const f=fixture(async()=>++calls===1?new Promise(r=>{finish=r;}):ready());const first=f.start();first();const stop=f.start();await flush();assert.ok(f.find(f.render(),'iframe'));finish({ok:true,json:async()=>({state:'error',message:'stale'})});await flush();assert.ok(f.find(f.render(),'iframe'));stop();assert.equal(f.timerCount,0);
});
