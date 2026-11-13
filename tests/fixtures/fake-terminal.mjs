import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
writeFileSync('spawn-args.json', JSON.stringify(process.argv.slice(2)));
const initialPath = /请读取 (.+)，按照/.exec(process.argv.at(-1) ?? '')?.[1] ?? readdirSync(process.cwd()).find(f => f.startsWith('prompt-'));
let promptText = readFileSync(resolve(process.cwd(), initialPath), 'utf8'), deliveryPath, requestId, uploads = 0;
const notify = JSON.parse(process.argv.find(a => a.startsWith('notify='))?.slice(7) ?? 'null');
function complete() { if (notify) spawnSync(notify[0], [...notify.slice(1), JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'fake-session', 'turn-id': String(Date.now()) })]); }
function deliver(receipt) { if (deliveryPath) writeFileSync(resolve(process.cwd(), deliveryPath), JSON.stringify({ ...receipt, requestId })); }
function upload(path) {
  promptText = readFileSync(path, 'utf8');
  deliveryPath = /delivery-[a-f0-9-]+\.json/.exec(promptText)?.[0]; requestId = /本次 requestId 固定为 ([a-f0-9-]+)/.exec(promptText)?.[1];
  uploads++; writeFileSync('upload-count.json', JSON.stringify(uploads)); process.stdout.write('\r\nUPLOAD_PROMPT_RECEIVED\r\n');
  const direction = /调研方向：([^。]+)/.exec(promptText)?.[1] ?? '';
  if (direction.includes('延迟')) return;
  if (direction.includes('保存失败') && uploads === 1) deliver({ status: 'failed', error: '验收注入：保存失败，请重试上传' });
  else if (/扫码|授权|二维码|Agent 负责飞书保存/.test(direction)) {
    const qr = /feishu-auth-[a-f0-9-]+\.png/.exec(promptText)?.[0];
    if (qr) writeFileSync(qr, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64'));
    deliver({ status: 'awaiting_authorization', authorizationUrl: 'https://accounts.feishu.cn/device?user_code=fixture', expiresAt: new Date(Date.now() + (direction.includes('二维码过期') && uploads === 1 ? -60000 : 600000) + 8 * 3600000).toISOString().replace('Z', '+08:00') });
  } else deliver({ status: 'published', url: 'https://example.feishu.cn/docx/agentReport123' });
  complete();
}
process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.write('\x1b[32mPTY_READY\x1b[0m\r\n原生命令行，等待输入 > ');
let input = '', repeat;
process.stdin.on('data', data => {
  for (const c of data.toString().replace(/\x1b\[\d+;\d+R/g, '').replace(/\x1b\[20[01]~/g, '')) {
    if (c === '\u0003') process.exit(0);
    if (c === '\x1b') { clearInterval(repeat); process.stdout.write('\r\nTURN_INTERRUPTED\r\n> '); input = ''; continue; }
    if (c === '\r' || c === '\n') {
      process.stdout.write(`\r\nINPUT:${input}\r\n`);
      const queued = /请读取 (.+)，按照.*用户上传要求/.exec(input);
      if (queued) upload(queued[1]);
      if (['REPORT', 'REPEAT_REPORT', 'REPORT_ONLY'].includes(input)) {
        const target = /report-[a-f0-9-]+\.json/.exec(promptText)?.[0];
        if (target) writeFileSync(target, JSON.stringify({ title: '原生终端验收报告', summary: '从真实 PTY 交互进程生成报告，验证文件交付和终端继续输入。', markdown: '# 原生终端验收\n\n此报告验证真实伪终端的原始字符、键盘输入、颜色输出、尺寸变化以及断线后重新连接，不需要将终端输出转换成消息卡片。[S1]', sources: [{ id: 'S1', title: '测试来源', url: 'https://example.com', excerpt: '用于测试终端文件交付的来源内容。' }] }));
        if (input === 'REPEAT_REPORT') repeat = setInterval(() => process.stdout.write('AUTO_RESEARCH\r\n'), 30);
        else complete();
      }
      if (['AUTHORIZED', 'UPLOAD'].includes(input)) { deliver({ status: 'published', url: 'https://example.feishu.cn/docx/agentReport123' }); complete(); }
      if (input === 'continue') complete();
      input = ''; process.stdout.write('> ');
    } else { input += c; process.stdout.write(c); }
  }
});
if (initialPath.includes('upload-prompt-')) upload(resolve(process.cwd(), initialPath));
process.on('SIGWINCH', () => process.stdout.write(`\r\nSIZE:${process.stdout.columns}x${process.stdout.rows}\r\n`));
