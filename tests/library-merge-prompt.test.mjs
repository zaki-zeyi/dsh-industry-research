import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefingCloudPrompt } from '../server/briefings.mjs';
import { industryCloudPrompt } from '../server/industry-prompt.mjs';
import { briefingPrompt } from '../server/briefing-prompt.mjs';
import { industryPrompt } from '../server/industry.mjs';

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
