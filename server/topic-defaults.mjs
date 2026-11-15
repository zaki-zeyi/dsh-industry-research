export function topicPrompt(v) {
  return `帮我对【${v.question}】在【${v.sources.join('、')}】进行调研${v.requirements ? `，并满足【${v.requirements}】` : ''}，自动去重增量保存到飞书云盘【专题调研】对应专题的【总报】中。报告按照【调研方向】【调研结论】【调研依据】组织，每条依据紧跟来源链接和日期，并呈现本次更新摘要。`;
}
export function topicDailyPrompt(v,range='{{时间范围}}') {
  return `帮我对【${v.question}】在【${v.sources.join('、')}】进行专题日报调研，统计【${range}】内的新披露${v.requirements ? `，并满足【${v.requirements}】` : ''}。保存到飞书云盘【专题调研】对应专题的【日报】目录，每期一份独立报告，不覆盖总报或其他日期的日报。每条依据紧跟来源链接和日期，并呈现本次更新摘要。`;
}
