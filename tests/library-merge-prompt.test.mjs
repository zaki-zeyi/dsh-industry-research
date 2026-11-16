import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefingCloudPrompt } from '../server/briefings.mjs';
import { industryCloudPrompt } from '../server/industry-prompt.mjs';
import { briefingPrompt } from '../server/briefing-prompt.mjs';
import { industryPrompt } from '../server/industry.mjs';
import { internalMaterialPrompt, internalMaterialCloudPrompt } from '../server/internal-materials.mjs';
import { topicDailyPrompt, withTopicTotalMerge } from '../server/topic-defaults.mjs';
import { topicTask, topicCloudPrompt } from '../server/topics.mjs';
import { libraryMergeRules, topicMergeRules, withLibraryMergeRules, withTopicMergeRules } from '../server/library-merge-prompt.mjs';
import { BriefingSchedules } from '../server/briefings.mjs';

const meta = { deliveryPath: 'delivery.json', deliveryRequestId: 'request-fixture' };
const check = prompt => {
  assert.match(prompt, /必须先完整读取目标公司文档/);
  assert.match(prompt, /维度—条目—事实—时间—来源/);
  assert.match(prompt, /条目级变更计划/);
  assert.match(prompt, /只用于会话审阅，禁止写入公司文档/);
  assert.match(prompt, /重复事实不新增段落/);
  assert.match(prompt, /补充信息更新原条目并保留全部来源/);
  assert.match(prompt, /状态更新保留旧状态、旧时间和来源/);
  assert.match(prompt, /【信息冲突】/);
  assert.match(prompt, /禁止在文档末尾新增“增量更新”/);
  assert.match(prompt, /修改完成后重新读取受影响的章节/);
};

test('日报写回全量信息库时要求先读整篇并原地条目级合并', () => {
  const task = {
    prompt: '生成日报',
    direction: '日报 · 测试区间',
    briefing: { kind: 'daily', companies: ['后摩智能'], dimensions: ['融资'], sources: ['公司官网'], requirements: '', window: { display: '测试区间', start: '2026-11-05T00:00:00Z', end: '2026-11-05T16:00:00Z' } },
    feishuRoot: { rootName: '行研工作台' },
    industryLibrary: { companies: [] },
    publication: {},
    feishuApp: { mode: 'default' },
  };
  check(briefingCloudPrompt(task, meta));
});

test('手动更新全量信息库时使用同一套原地合并规则', () => {
  const task = {
    prompt: '更新全量信息库',
    industry: { companies: ['后摩智能'], dimensions: ['融资'], sources: ['公司官网'], requirements: '' },
    feishuRoot: { rootName: '行研工作台' },
    industryLibrary: { companies: [] },
    feishuApp: { mode: 'default' },
    runs: [],
  };
  check(industryCloudPrompt(task, meta));
});

test('默认任务提示词明确要求就地合并且不新增增量章节', () => {
  const input = { companies: ['后摩智能'], dimensions: ['融资'], sources: ['公司官网'], requirements: '', kind: 'daily' };
  assert.match(briefingPrompt(input, { display: '测试区间' }), /按维度就地合并/);
  assert.match(briefingPrompt(input, { display: '测试区间' }), /不新增“增量更新”章节/);
  assert.match(industryPrompt(input), /按维度就地合并/);
  assert.match(industryPrompt(input), /不新增“增量更新”章节/);
});

test('PRD4821 日报、周报和内部资料的配置提示词包含完整强制合并规则', () => {
  const input={companies:['后摩智能'],dimensions:['融资'],sources:['公司官网'],requirements:'保留人工备注'};
  for(const kind of ['daily','weekly'])check(briefingPrompt({...input,kind},{display:'{{时间范围}}'}));
  check(internalMaterialPrompt({source:'https://example.feishu.cn/docx/Source',requirements:'核对数字'}));
});

test('PRD4821 内部资料自定义及旧提示词不能漏过完整合并规则，不重复注入', () => {
  const internal={sourceType:'url',source:'https://example.feishu.cn/docx/Source',sourceLabel:'访谈',directoryName:'内部资料'};
  const custom='请特别核对芯片参数，保留我的研究要求。\n【全量信息库合并规则（强制）】';
  const task={internal,prompt:custom,feishuApp:{mode:'default'},industryLibrary:{companies:[]}};
  const prompt=internalMaterialCloudPrompt(task,meta);check(prompt);assert.ok(prompt.includes(custom));
  const generated=internalMaterialPrompt(internal);
  const final=internalMaterialCloudPrompt({...task,prompt:generated},meta);
  assert.equal(final.split(libraryMergeRules.trim()).length-1,1);
  assert.equal(withLibraryMergeRules(withLibraryMergeRules(custom)),withLibraryMergeRules(custom));
  assert.match(final,/无命中不创建信息库目录/);
});

test('PRD4821 专题日报将完整规则应用于总报，保留自定义要求、原链接与独立日报', () => {
  const v={question:'agent harness',sources:['公司官网'],requirements:'比较运行成本'};
  const generated=topicDailyPrompt(v);assert.ok(generated.includes(topicMergeRules.trim()));
  assert.match(generated,/每期一份独立报告/);
  const old='调研 {{时间范围}}，重点比较运行成本。\n每日日报信息去重增量保存到【本专题调研】的总报。';
  const upgraded=withTopicTotalMerge(old);
  assert.equal(withTopicTotalMerge(upgraded),upgraded);
  assert.match(upgraded,/重点比较运行成本/);assert.match(upgraded,/去重合并保存/);
  const task={...topicTask({...v,prompt:old},new Date('2026-11-16T01:00:00Z')),feishuApp:{},publication:{}};
  const actual=topicCloudPrompt(task,meta);
  assert.ok(actual.includes(topicMergeRules.trim()));
  assert.match(actual,/必须先完整读取目标专题总报/);
  assert.match(actual,/禁止把本次调研摘要或专题日报整体追加到专题总报/);
  assert.match(actual,/已有总报必须复用原链接/);
  assert.match(actual,/两份文档都读回核对后才能回传 published/);
  assert.doesNotMatch(actual,/确认后才更新公司索引/);
  const configured=topicCloudPrompt({...task,prompt:generated},meta);
  assert.equal(configured.split(topicMergeRules.trim()).length-1,1);
});

test('PRD4821 旧日报周报配置读出时补齐规则，不改保存数据或自动化时间', () => {
  const oldPrompt='重点研究最近产品性能，区间 {{时间范围}}。';
  const research={companies:['后摩智能'],dimensions:['融资'],sources:['公司官网'],prompt:oldPrompt};
  const saved={plans:{daily:{kind:'daily',time:'10:10',enabled:true,research},weekly:{kind:'weekly',time:'11:20',weekday:5,enabled:false,research}}};
  const service={store:{setting:()=>saved}};
  const schedules=new BriefingSchedules(service,{},'http://localhost');
  for(const kind of ['daily','weekly']){
    const plan=schedules.get(kind);check(plan.research.prompt);assert.ok(plan.research.prompt.includes(oldPrompt));
    assert.equal(plan.time,saved.plans[kind].time);assert.equal(plan.enabled,saved.plans[kind].enabled);
    assert.equal(saved.plans[kind].research.prompt,oldPrompt);
  }
});

test('PRD4896 新状态附时间及来源链接，上一版完整规则原位升级且保留用户要求',()=>{
  const old=libraryMergeRules.replace('【全量信息库合并规则】','【全量信息库合并规则（强制）】').replace('同时写入新状态、时间和来源','同时写入新状态和时间').replace('每条条目紧跟来源链接及对应时间，保留已有人工备注。\n','');
  const prompt=withLibraryMergeRules('重点研究产品历史。\n'+old+'\n保留原始要求。');
  assert.match(prompt,/重点研究产品历史/);assert.match(prompt,/保留原始要求/);
  assert.match(prompt,/同时写入新状态、时间和来源/);assert.match(prompt,/每条条目紧跟来源链接及对应时间/);
  assert.doesNotMatch(prompt,/（强制）/);assert.equal(prompt.split('【全量信息库合并规则】').length-1,1);
  assert.equal(withLibraryMergeRules(prompt),prompt);
  const previousTopic=topicMergeRules.replace('【专题总报合并规则】','【专题总报合并规则（强制）】').replace('同时写入新状态、时间和来源','同时写入新状态和时间').replace('每条条目紧跟来源链接及对应时间，保留已有人工备注。\n','');
  const next=withTopicMergeRules(previousTopic);assert.equal(next,topicMergeRules);assert.equal(withTopicMergeRules(next),next);
});
