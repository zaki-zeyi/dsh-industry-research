const previousLibraryRules = `
【全量信息库合并规则（强制）】
写回公司文档前，必须先完整读取目标公司文档，建立“维度—条目—事实—时间—来源”清单；不得只看文档末尾或最近一次更新。
将本次资料拆成独立事实，逐条与已有条目比较，并分类为：重复、补充、状态更新、冲突、新增。
写入前先在 AI 会话输出“条目级变更计划”，逐条注明：目标维度/章节、目标条目、分类、处理动作和原因。该计划只用于会话审阅，禁止写入公司文档，也禁止写入日报/周报正文。
按计划在原位置修改：重复事实不新增段落，只补充来源；补充信息更新原条目并保留全部来源；状态更新保留旧状态、旧时间和来源，同时写入新状态和时间；冲突信息并列保留双方来源、日期并标注【信息冲突】，不得自行覆盖；只有现有维度均不适配时才新增条目或维度。
禁止在文档末尾新增“增量更新”“本次更新”“同日复述”“调研摘要”等整体章节；禁止把本次调研摘要整体追加到公司文档。
修改完成后重新读取受影响的章节，核对重复、结构、时间顺序和来源完整性；确认后才更新公司索引的 added/conflicts 并回传。
`;

export const libraryMergeRules = previousLibraryRules
  .replace('【全量信息库合并规则（强制）】','【全量信息库合并规则】')
  .replace('同时写入新状态和时间','同时写入新状态、时间和来源')
  .replace('修改完成后重新读取受影响的章节','每条条目紧跟来源链接及对应时间，保留已有人工备注。\n修改完成后重新读取受影响的章节');

const forTopic = rules => rules
  .replace('【全量信息库合并规则】', '【专题总报合并规则】')
  .replace('【全量信息库合并规则（强制）】', '【专题总报合并规则（强制）】')
  .replaceAll('公司文档', '专题总报')
  .replace('也禁止写入日报/周报正文', '也禁止写入专题日报正文')
  .replace('禁止把本次调研摘要整体追加到专题总报', '禁止把本次调研摘要或专题日报整体追加到专题总报')
  .replace('确认后才更新公司索引的 added/conflicts 并回传', '确认后才回传已合并的总报链接 topicTotalUrl');
export const topicMergeRules=forTopic(libraryMergeRules);

// Defaults, saved schedules and runtime instructions use the same complete
// policy. A custom prompt containing only its heading must not bypass it.
export function withLibraryMergeRules(prompt) {
  const text=prompt.replaceAll(previousLibraryRules.trim(),libraryMergeRules.trim());
  return text.includes(libraryMergeRules.trim()) ? text : text + libraryMergeRules;
}
export function withTopicMergeRules(prompt) {
  const text=prompt.replaceAll(forTopic(previousLibraryRules).trim(),topicMergeRules.trim());
  return text.includes(topicMergeRules.trim()) ? text : text + topicMergeRules;
}
