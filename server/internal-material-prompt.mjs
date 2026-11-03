// Shared by the form and server; no runtime dependencies.
export function internalMaterialPrompt({ source, requirements = '', directoryName = '内部资料' }) {
  return `如果【${source || '资料来源'}】是本地文件，将原始资料上传到飞书根目录【${directoryName}】的【原始资料】下。解析视频时先提取音轨；录音根据【时间】【说话人】【话语】生成逐字稿并校对ASR错误，保留数字、限定条件、问答和原始信息，身份无法确认标为未知，听不清处显式标记。已有逐字稿或文档则直接核对使用。满足【${requirements || '无'}】，逐字稿标注原始资料链接并保存到【${directoryName}】的【逐字稿】。根据逐字稿生成会议纪要，标注逐字稿和原始资料链接，保存到【${directoryName}】的【会议纪要】。如提及配置中的调研公司，提取去重并增量保存到【全量信息库】对应公司文档。`;
}
