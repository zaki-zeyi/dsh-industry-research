// Accept common clipboard wrappers, never guess or remove arbitrary characters
// from the token itself. Error messages must not contain any part of the value.
export function normalizeApiKey(input) {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('API Key 格式无效');
  let value = input.trim();
  const assignment = /^(?:(?:export|set)\s+)?([A-Za-z_][A-Za-z0-9_ ()/.-]{0,80})\s*[:=：]\s*([^\r\n]+)$/i.exec(value);
  if (assignment && /api[ _-]*key|token|authorization/i.test(assignment[1])) value = assignment[2].trim();
  value = value.replace(/^Bearer\s+/i, '').trim();
  if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1).trim();
  if (!value || !/^[\x21-\x7e]+$/.test(value) || /["'`]/.test(value)) throw new Error('API Key 必须是纯密钥，不能包含中文、说明文字、空格、换行或不可见字符；请重新粘贴控制台复制的完整密钥');
  return value;
}
