const labelFor = kind => kind === 'daily' ? '日报' : '周报';
export function reportWindow(kind, now = new Date()) {
  const date = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const end = new Date(date + 'T00:00:00+08:00');
  const start = new Date(end.getTime() - (kind === 'weekly' ? 7 : 1) * 86400000);
  const fmt = d => new Date(d.getTime() + 8 * 3600000).toISOString().slice(0,16).replace('T',' ');
  return { start: start.toISOString(), end: end.toISOString(), display: `${fmt(start)} 至 ${fmt(new Date(end - 60000))}（北京时间）` };
}
export function briefingPrompt(input, window) {
  return `帮我统计【${window.display}】内，对【${input.companies.join('、')}】在【${input.sources.join('、')}】的【${input.dimensions.join('、')}】相关动态，并满足【${input.requirements || '无其他要求'}】，保存到飞书云盘根目录的【${labelFor(input.kind)}】目录中，同时自动去重增量保存到飞书云盘根目录的【全量信息库】中。并呈现本次更新摘要。`;
}
