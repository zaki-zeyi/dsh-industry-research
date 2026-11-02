import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
// Deliberately separate from npm run acceptance: this creates a real document.
if (process.env.RUN_LIVE_ACCEPTANCE !== '1') throw new Error('真实验收会执行模型请求并向已配置飞书目录创建文档。设置 RUN_LIVE_ACCEPTANCE=1 后运行。');
const base = process.env.WORKBENCH_URL ?? 'http://127.0.0.1:3088';
const request=async(path,options)=>{const r=await fetch(`${base}/api${path}`,options);const d=await r.json();assert.ok(r.ok,JSON.stringify(d));return d;};
assert.equal((await request('/config')).mode,'live','请先将服务配置为 live 模式');
const input={direction:process.env.RESEARCH_DIRECTION??'DeepSeek Harness 的官方插件架构与适用边界',sources:'https://github.com/deepseek-ai/deepseek-harness'};
const key=crypto.randomUUID();const options={method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(input)};
const task=await request('/tasks',options);assert.equal((await request('/tasks',options)).id,task.id);
console.log(`真实调研已创建：${task.id}`);
const start=Date.now();let detail;
while(Date.now()-start<900000){detail=await request(`/tasks/${task.id}`);if(detail.task.publication.status==='published')break;if(['failed','interrupted'].includes(detail.task.status)||['failed','interrupted'].includes(detail.task.publication.status))throw new Error(detail.task.error??detail.task.publication.error);await setTimeout(2000);}
assert.equal(detail.task.publication.status,'published','真实调研/发布超时，请在工作台查看已有任务，勿盲目新建');assert.ok(detail.task.report.sources.length);assert.match(detail.task.publication.url,/^https:\/\/.+\/docx\//);assert.equal(detail.task.runs.length,1);
const events=detail.events;const reopened=await request(`/tasks/${task.id}`);assert.deepEqual(reopened.events,events);
console.log(`PASS：报告已生成，历史可回放，飞书返回链接 ${detail.task.publication.url}`);
console.log('还需人工打开飞书链接核对目标目录、正文、来源及访问权限；本脚本不自动删除验收文档。');
