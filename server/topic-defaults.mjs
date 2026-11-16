export const topicTotalTitle=question=>question+'专题调研总报';
export function topicPrompt(v) {
  return `帮我对【${v.question}】在【${v.sources.join('、')}】进行调研${v.requirements ? `，并满足【${v.requirements}】` : ''}，自动去重增量保存到飞书云盘【专题调研】对应专题的【总报】中，文档命名为【${topicTotalTitle(v.question)}】。关键信息注明来源链接和日期，并呈现本次更新摘要。`;
}
export function topicDailyPrompt(v,range='{{时间范围}}') {
  return withTopicTotalMerge(`帮我对【${v.question}】在【${v.sources.join('、')}】进行专题日报调研，统计【${range}】内的新披露${v.requirements ? `，并满足【${v.requirements}】` : ''}。保存到飞书云盘【专题调研】对应专题的【日报】目录，每期一份独立报告，不覆盖其他日期的日报。关键信息注明来源链接和日期，并呈现本次更新摘要。`);
}
// Only replace wording from the former built-in template; keep custom research requirements.
export function normalizeTopicPrompt(prompt) {
  return prompt
    .replace(/报告(?:按照|按|明确包含)【调研(?:方向|问题)】【调研结论】【调研依据】(?:组织)?/g,'报告结构根据调研内容组织')
    .replaceAll('报告按问题、结论、依据组织','报告结构根据调研内容组织');
}
// Upgrade saved defaults and custom prompts without losing the user's research instructions.
export function withTopicTotalMerge(prompt) {
  const text=normalizeTopicPrompt(prompt).replaceAll('不覆盖总报或其他日期的日报','不覆盖其他日期的日报');
  const requirement='每日日报信息去重增量保存到【本专题调研】的总报。';
  return text.includes(requirement)?text:text+'\n'+requirement;
}
