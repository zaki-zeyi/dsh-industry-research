import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const send = data => process.stdout.write(`${JSON.stringify(data)}\n`);
send({ type: 'thread.started', thread_id: 'codex-test-thread' });
send({ type: 'turn.started' });
send({ type: 'item.completed', item: { id: 'intro', type: 'agent_message', text: '已收到调研 Prompt，开始整理资料。' } });
send({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'printf "CLI_STREAM_OK"', aggregated_output: '', status: 'in_progress' } });
if (prompt.includes('CLI_CANCEL')) await delay(60000);
await delay(350);
send({ type: 'item.updated', item: { id: 'cmd-1', type: 'command_execution', aggregated_output: 'CLI_STREAM_OK\n', status: 'in_progress' } });
await delay(350);
send({ type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', aggregated_output: 'CLI_STREAM_OK\n', exit_code: 0, status: 'completed' } });
if (prompt.includes('CLI_FAIL')) { send({ type: 'turn.failed', error: { message: '测试 Codex CLI 异常退出' } }); process.exit(3); }
const report = { title: 'Codex CLI 验收报告', summary: '本报告来自模拟命令行，用于验证实际进程的标准输入、JSONL 流和历史回放。', markdown: '# Codex CLI 验收报告\n\n本次测试验证调研 Prompt 通过标准输入交给命令行，前端显示消息、工具调用及命令输出，刷新页面后仍能回看完整记录。[S1]', sources: [{ id: 'S1', title: '测试引用', url: 'https://learn.chatgpt.com/docs/non-interactive-mode', excerpt: 'Codex exec 提供 JSONL 事件，适合非交互式运行时消费。' }] };
send({ type: 'item.completed', item: { id: 'final', type: 'agent_message', text: JSON.stringify(report) } });
send({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 80 } });
if (prompt.includes('CLI_PIPE_HELD')) { spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); process.exit(0); }
