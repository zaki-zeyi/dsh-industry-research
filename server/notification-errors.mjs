function parsePayload(error) {
  for (const candidate of [error?.stderr, error?.stdout, error?.message]) {
    if (typeof candidate !== 'string') continue;
    const text = candidate.trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (value?.error && typeof value.error === 'object') return value.error;
    } catch {}
  }
  return null;
}

export function notificationFailure(error) {
  const payload = parsePayload(error);
  const code = typeof payload?.code === 'number' || typeof payload?.code === 'string' ? String(payload.code) : '';
  const subtype = typeof payload?.subtype === 'string' ? payload.subtype.slice(0, 80) : '';
  const type = typeof payload?.type === 'string' ? payload.type.slice(0, 80) : '';
  const missingScopes = Array.isArray(payload?.missing_scopes)
    ? payload.missing_scopes.filter(value => typeof value === 'string').map(value => value.slice(0, 120)).slice(0, 20)
    : [];
  const upstream = typeof payload?.message === 'string' ? payload.message.replace(/\s+/g, ' ').trim().slice(0, 220) : '';
  const diagnostic = {
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
    ...(subtype ? { subtype } : {}),
    ...(missingScopes.length ? { missingScopes } : {}),
  };

  if (missingScopes.includes('im:message:send_as_bot') || /send_as_bot/i.test(upstream)) {
    return {
      message: '当前飞书应用尚未获得机器人发消息权限（im:message:send_as_bot）。请点击“修复机器人权限”，在飞书确认权限差异并发布，然后重试通知。',
      diagnostic,
    };
  }
  if (subtype === 'app_scope_not_applied' || /has not applied for the required scope/i.test(upstream)) {
    return {
      message: `当前飞书应用所需权限尚未生效${code ? `（错误码 ${code}）` : ''}。请点击“修复机器人权限”，确认权限差异并发布后重试。`,
      diagnostic,
    };
  }
  if (/bot unavailable|机器人身份不可用/i.test(upstream) || /bot unavailable|机器人身份不可用/i.test(String(error?.message ?? ''))) {
    return {
      message: '飞书机器人身份不可用，无法发送消息。请点击“修复机器人权限”，确认已开通 im:message:send_as_bot 并发布后再重试。',
      diagnostic,
    };
  }
  if (/availability|available range|not available|可用范围/i.test(upstream)) {
    return {
      message: '当前飞书账号不在机器人可用范围内。请把该账号加入应用可用范围并发布应用后重试。',
      diagnostic,
    };
  }
  if (/current.*(binding|application).*(changed|mismatch)|绑定.*(已切换|不一致)/i.test(`${upstream} ${error?.message ?? ''}`)) {
    return {
      message: '当前绑定的飞书账号或应用已发生变化，历史任务不会向旧账号发送通知。请确认当前绑定后重新生成报告，或恢复原绑定再重试。',
      diagnostic,
    };
  }
  if (type === 'authorization' || type === 'forbidden' || /access denied|permission denied/i.test(upstream)) {
    return {
      message: `飞书机器人无权发送消息${code ? `（错误码 ${code}）` : ''}。请检查应用发布状态、机器人消息权限和账号可用范围后重试。`,
      diagnostic,
    };
  }
  return {
    message: `飞书机器人未发送成功${code ? `（错误码 ${code}）` : ''}${upstream ? `：${upstream}` : ''}。报告和会话已保留，可修复配置后重试。`,
    diagnostic,
  };
}

export function notificationApplicationMatches(expected, current) {
  if (!expected || !current) return false;
  const expectedMode = expected.mode ?? 'default';
  const currentMode = current.mode ?? 'default';
  if (expectedMode !== currentMode) return false;
  if (currentMode === 'default' && (!expected.appId || !current.appId)) return true;
  return (expected.appId ?? '') === (current.appId ?? '')
    && (expected.profile ?? '') === (current.profile ?? '');
}
