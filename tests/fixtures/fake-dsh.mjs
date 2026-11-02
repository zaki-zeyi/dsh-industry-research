import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2), patch = JSON.parse(readFileSync(args[args.indexOf('--patch') + 1], 'utf8'));
const config = patch.find(x => x.insert)?.insert[0].config, sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : randomUUID();
writeFileSync(config.sessionPath, JSON.stringify({ sessionId }));
writeFileSync('dsh-args.json', JSON.stringify(args));
writeFileSync('dsh-env.json', JSON.stringify({ hasWorkbenchApiKey: Object.hasOwn(process.env, 'RESEARCH_DSH_API_KEY') }));
const report = { title: 'DSH 原生终端报告', summary: '这是来自原生 DSH 终端的完整验收摘要。', markdown: '这是足够长的报告正文，包含独立证据与对应的数据来源引用，验证工作台可以读取并校验真实文件回执。[S1]', sources: [{ id: 'S1', title: '验收来源', url: 'https://example.com/source', excerpt: '这是可用于验收校验的来源摘录。' }] };
let input = '', count = 0;
const complete = (extra = {}) => writeFileSync(config.completionPath, JSON.stringify({ type: 'turn-complete', sessionId, turnId: String(++count), at: new Date().toISOString(), ...extra }));
process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write(patch.some(x => x.id === 'tui') ? 'prompt › Ask anything...\r\n' : '输入 › 请输入要求...\r\n');
process.stdin.on('data', chunk => {
  for (const char of chunk.toString().replace(/\x1b\[20[01]~/g, '')) {
    if (char === '\r' || char === '\n') {
      const file = /请读取 (.+)，按照/.exec(input)?.[1];
      if (file) {
        const prompt = readFileSync(file, 'utf8');
        if (process.env.RESEARCH_DSH_API_KEY === 'fake-rejected-key') { complete({ reason: 'error', errorCode: 'INVALID_CREDENTIAL' }); input = ''; continue; }
        if (prompt.includes('用户点击了“上传飞书”')) {
          const path = /原子更新 (.+)，本次 requestId/.exec(prompt)[1], requestId = /本次 requestId 固定为 ([a-f0-9-]+)/.exec(prompt)[1];
          writeFileSync(path, JSON.stringify({ status: 'published', requestId, url: 'https://example.feishu.cn/docx/dshReport123' }));
        } else { const reportPath = /完整报告 JSON 保存到 (.+)。本轮/.exec(prompt)[1]; writeFileSync(reportPath, JSON.stringify(report)); }
      }
      process.stdout.write(`INPUT:${input}\r\n`); input = ''; complete();
    } else input += char;
  }
});
