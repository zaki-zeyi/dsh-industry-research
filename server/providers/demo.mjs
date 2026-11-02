import { setTimeout as delay } from 'node:timers/promises';
export class DemoResearcher {
  constructor({ delayMs = 650, failResearch = false } = {}) { this.delayMs = delayMs; this.failResearch = failResearch; }
  async run(task, { emit, session, checkpoint, signal }) {
    session(`demo-${task.id}-${task.runs.length}`);
    emit('assistant', '我会先明确研究范围，再收集来源、对比证据，最后整理报告。本次为离线演示，不代表真实调研结论。');
    await delay(this.delayMs, null, { signal });
    emit('tool', 'search · 正在演示检索与来源整理');
    const markdown = `# ${task.direction}\n\n> 离线演示报告：以下内容用于验证工作台流程，不是针对该主题的真实研究。\n\n## 核心观察\n\n建议从应用场景、技术能力和落地成本三个维度建立研究框架。每项结论应关联可核对的来源，区分已验证事实与推断。[S1]\n\n## 后续研究方向\n\n- 明确研究对象及时间范围\n- 收集第一手资料与可比较的数据\n- 对关键结论交叉验证，记录证据与限制\n\n## 实施建议\n\n先用小范围试点验证工作流程，保留执行记录，再根据真实调研结果调整方案。[S1]`;
    checkpoint(markdown.slice(0, 170));
    await delay(this.delayMs, null, { signal });
    if (this.failResearch) { this.failResearch = false; throw new Error('验收注入：调研中断，已保留草稿'); }
    emit('assistant', '演示资料已整理，正在生成带来源的报告。');
    await delay(this.delayMs, null, { signal });
    return { title: task.direction, summary: '离线演示：从研究范围、资料收集与证据验证三个步骤展示调研流程。切换真实模式后生成实际研究报告。', markdown, sources: [{ id: 'S1', title: 'DeepSeek Harness 官方仓库（演示来源）', url: 'https://github.com/deepseek-ai/deepseek-harness', excerpt: '演示来源占位：该仓库介绍插件化 Agent Harness；本次演示未在线读取来源。', accessedAt: new Date().toISOString() }] };
  }
}
