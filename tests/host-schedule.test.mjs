import test from 'node:test';
import assert from 'node:assert/strict';
import {saveHostSchedule,removeHostSchedule} from '../server/host-schedule.mjs';
test('新版官方日报周报接口显式提供目标会话，删除通过edit',async()=>{
 const calls=[],service={create:async(request,actor)=>{calls.push({request,actor});return{id:'new',...request};},edit:async(request,actor)=>{calls.push({request,actor});return{id:request.id,deleted:true};}};
 await saveHostSchedule(service,'session',{title:'日报',prompt:'运行任务',daily:{time:'09:00:00',time_zone:'Asia/Shanghai'}});
 await saveHostSchedule(service,'session',{title:'周报',prompt:'运行任务',weekly:{time:'09:00:00',time_zone:'Asia/Shanghai',weekdays:[5]}});
 assert.equal(calls[0].request.timing.kind,'daily');assert.equal(calls[1].request.timing.kind,'weekly');assert.deepEqual(calls[1].request.target,{kind:'session',sessionId:'session'});
 await removeHostSchedule(service,'session','new');assert.deepEqual(calls[2],{request:{id:'new',action:'delete'},actor:'session'});
});
test('旧接口替换失败保留原任务，新接口不确认时禁止宣称保存成功',async()=>{
 let deletes=0;const legacy={create:async()=>{throw Error('failed');},delete:async()=>{deletes++;}};
 await assert.rejects(saveHostSchedule(legacy,'session',{title:'日报',prompt:'prompt',daily:{}},{id:'old'}));assert.equal(deletes,0);
 await assert.rejects(saveHostSchedule({create:async()=>({}),edit:async()=>{}},'session',{title:'日报',prompt:'prompt',daily:{}}),e=>e.status===503);
});
