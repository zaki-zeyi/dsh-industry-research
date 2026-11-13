import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefingCloudPrompt } from '../server/briefings.mjs';
import { cloudPrompt } from '../server/cloud-research.mjs';
import { uploadPrompt } from '../server/upload-prompt.mjs';

const app = { mode: 'custom', appId: 'cli_fixture123', profile: 'research-fixture' };
const root = { rootName: '行研工作台', folderToken: 'rootFolder' };
const meta = { deliveryPath: 'delivery.json', deliveryRequestId: '12345678-1234-4234-8234-123456789abc' };

test('用户可见飞书文档标题不包含任务ID、requestID或版本号', () => {
  const task = {
    id: '9692c07c-7664-4936-9603-88e7c02b4ac9',
    direction: '日报 · 2026-11-02 00:00 至 2026-11-02 23:59（北京时间）',
    prompt: '统计日报',
    runs: [],
    feishuApp: app,
    feishuRoot: root,
    briefing: {
      kind: 'daily',
      companies: ['后摩智能'],
      dimensions: ['融资'],
      sources: ['公司官网'],
      requirements: '',
      window: { start: '2026-11-01T16:00:00Z', end: '2026-11-02T16:00:00Z', display: '2026-11-02 00:00 至 2026-11-02 23:59（北京时间）' },
    },
  };
  const briefing = briefingCloudPrompt(task, meta);
  assert.match(briefing, /文档标题严格使用/);
  assert.ok(!briefing.includes(task.id));

  const genericTask = { ...task, briefing: undefined, report: { title: '日报 · 2026-11-02', version: 3 } };
  const generic = cloudPrompt(genericTask, meta);
  assert.ok(!generic.includes(task.id));

  const upload = uploadPrompt({ ...genericTask, autoUpload: false }, { qrPath: 'qr.png' }, meta.deliveryRequestId, 'upload-report.md');
  assert.match(upload, /目标文档标题严格使用：日报 · 2026-11-02/);
  assert.ok(!upload.includes(task.id));
  assert.ok(!upload.includes('v3'));
});
