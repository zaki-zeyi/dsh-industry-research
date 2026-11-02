// Fold item updates into one stable message. Persisted events remain append-only.
export function conversationEntries(events) {
  const entries = [], items = new Map();
  for (const e of events) {
    if (['state', 'runtime'].includes(e.type)) continue;
    if (e.type !== 'cli') { entries.push({ ...e, label: ({ user: '调研任务', assistant: '研究助手', tool: '工具执行', system: '系统记录', error: '执行异常' })[e.type] ?? e.type, text: typeof e.data === 'string' ? e.data : JSON.stringify(e.data) }); continue; }
    const d = e.data;
    if (d.type.startsWith('item.') && d.item?.id) {
      const key = `${d.runId}:${d.item.id}`;
      let entry = items.get(key);
      if (!entry) { entry = { seq: e.seq, at: e.at, type: 'cli-item', runId: d.runId, item: {} }; items.set(key, entry); entries.push(entry); }
      entry.item = { ...entry.item, ...d.item };
      entry.finished = d.type === 'item.completed';
    } else if (d.type === 'process.started') entries.push({ seq: e.seq, at: e.at, type: 'cli-launch', label: 'Codex CLI', text: d.command });
    else if (d.type === 'thread.started') entries.push({ seq: e.seq, at: e.at, type: 'system', label: 'Codex 会话已连接', text: d.thread_id });
    else if (['process.output', 'process.stderr', 'error', 'turn.failed'].includes(d.type)) entries.push({ seq: e.seq, at: e.at, type: d.type === 'error' || d.type === 'turn.failed' ? 'error' : 'cli-log', label: d.type === 'process.stderr' ? 'CLI 诊断' : 'CLI 输出', text: d.text ?? d.message ?? d.error?.message ?? '命令行执行失败' });
    else if (d.type === 'turn.completed') entries.push({ seq: e.seq, at: e.at, type: 'system', label: 'Codex 执行完成', text: d.usage ? `输入 ${d.usage.input_tokens ?? 0} tokens · 输出 ${d.usage.output_tokens ?? 0} tokens` : '执行完成' });
  }
  return entries;
}
