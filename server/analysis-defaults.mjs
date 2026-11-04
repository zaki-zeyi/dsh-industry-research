export const ANALYSIS_FOLDER_NAME = '友商分析';

export function analysisDefaultPrompt(companies, dimensions) {
  return `帮我从飞书根目录【全量信息库】里，提取【${companies.join('、')}】的相关信息，在【${dimensions.join('、')}】进行详细对比，输出这些公司的相同点、差异点及分析，可以使用图表来丰富报告的表达，在使用表格来做数据对比时，对于优势数据要做高亮处理。最终整理成带数据来源的报告，对比报告里的数据必须严格来自【全量信息库】。将报告自动保存到飞书根目录的【友商分析】中。`;
}

export function cleanAnalysisTitle(value) {
  const title = String(value ?? '').trim();
  if (!title) return title;
  return title.replace(/\s*(?:[·|_\-—–]\s*)?[（(]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[)）]?\s*$/i, '').trim() || title;
}
