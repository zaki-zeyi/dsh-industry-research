export function topicPrompt(v) {
  return `帮我对【${v.question}】在【${v.sources.join('、')}】进行调研${v.requirements ? `，并满足【${v.requirements}】` : ''}，自动去重增量保存到飞书云盘【专题调研库】中。报告按照【调研问题】【调研结论】【调研依据】组织，每条依据紧跟来源链接和日期，并呈现本次更新摘要。`;
}
