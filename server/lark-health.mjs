const recovery = (code, action, automatic, message) => ({ code, action, automatic, message });

/**
 * Turn lark-cli's verbose authentication result into a small, stable recovery
 * contract. The UI only needs to know which local action can resolve the state.
 */
export function larkRecoveryForStatus(result, { missingScopes = [], accountMismatch = false } = {}) {
  const identities = result?.identities ?? {};
  const user = identities.user ?? {};
  const bot = identities.bot ?? {};
  const dpop = String(result?.dpopKeyStatus ?? '').toLowerCase();
  const dpopMessage = `${user.message ?? ''}\n${user.hint ?? ''}`;
  const tokenStatus = String(user.tokenStatus ?? '').toLowerCase();

  if (!result?.appId || bot.status === 'not_configured') {
    return recovery(
      'LARK_APP_NOT_CONFIGURED',
      'register_app',
      true,
      '本机尚未配置飞书应用，将自动打开扫码登录与应用绑定流程。',
    );
  }

  if ((dpop && !['available', 'ready', 'present'].includes(dpop)) || /DPoP|KeyStore|Keychain|key unavailable|key inconsistent|0x80090016/i.test(dpopMessage)) {
    return recovery(
      'LARK_DPOP_KEY_UNAVAILABLE',
      'authorize',
      true,
      '本机飞书登录密钥不可用，将自动重新发起扫码授权；完成扫码后会自动恢复。',
    );
  }

  if (['expired', 'needs_refresh', 'missing'].includes(tokenStatus)) {
    return recovery(
      'LARK_USER_AUTH_EXPIRED',
      'authorize',
      true,
      '飞书个人授权已失效，将自动重新发起扫码授权；完成扫码后会自动恢复。',
    );
  }

  if (accountMismatch) {
    return recovery(
      'LARK_ACCOUNT_MISMATCH',
      'rebind_app',
      false,
      '个人授权账号与应用绑定账号不一致，请使用同一账号重新扫码绑定应用。',
    );
  }

  if (user.available !== true || user.verified !== true) {
    return recovery(
      'LARK_USER_AUTH_REQUIRED',
      'authorize',
      true,
      '飞书个人身份尚未授权，将自动生成登录二维码；完成扫码后会自动恢复。',
    );
  }

  if (missingScopes.length) {
    const driveRead = missingScopes.includes('space:document:retrieve');
    return recovery(
      'LARK_SCOPE_MISSING',
      'authorize',
      true,
      driveRead
        ? '飞书授权缺少云盘目录读取权限，将自动重新发起授权；完成扫码后会自动恢复。若仍失败，请在飞书开放平台为应用开通云盘文件读取权限。'
        : '飞书授权缺少文档或云盘权限，将自动重新发起授权；完成扫码后会自动恢复。',
    );
  }

  return null;
}

function errorText(error) {
  return [
    error?.code,
    error?.message,
    error?.description,
    error?.stderr,
    error?.stdout,
    error?.cause?.code,
    error?.cause?.message,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Classify failures without returning command output or credentials to the UI.
 */
export function larkRecoveryForError(error) {
  const text = errorText(error);

  if (/ENOENT|command not found|不是内部或外部命令|找不到 Lark CLI|not recognized as/i.test(text)) {
    return recovery(
      'LARK_CLI_NOT_FOUND',
      'install_cli',
      false,
      '未找到 lark-cli。请由工作台安装程序修复命令行组件后重试。',
    );
  }

  if (/Execution_Policies|running scripts is disabled|禁止运行脚本|UnauthorizedAccess/i.test(text)) {
    return recovery(
      'LARK_POWERSHELL_POLICY',
      'repair_cli',
      false,
      'PowerShell 阻止了 lark-cli 脚本。工作台会优先使用原生入口；如仍失败，请修复本机 CLI 安装。',
    );
  }

  if (/DPoP|dpop|KeyStore|Keychain|key unavailable|key inconsistent|0x80090016/i.test(text)) {
    return recovery(
      'LARK_DPOP_KEY_UNAVAILABLE',
      'authorize',
      true,
      '本机飞书登录密钥不可用，请重新扫码授权以恢复签名密钥。',
    );
  }

  if (/access_denied|authorization_denied|cancel(?:led)?|已取消/i.test(text)) {
    return recovery(
      'LARK_AUTHORIZATION_DENIED',
      'authorize',
      true,
      '本次飞书授权已取消，可重新生成二维码后再扫码。',
    );
  }

  if (/expired_token|expired|已过期/i.test(text)) {
    return recovery(
      'LARK_AUTHORIZATION_EXPIRED',
      'authorize',
      true,
      '飞书授权二维码已过期，请重新生成后再扫码。',
    );
  }

  if (/invalid_client|client_secret|app_id|not supported|应用凭据|应用配置/i.test(text)) {
    return recovery(
      'LARK_APP_NOT_CONFIGURED',
      'register_app',
      true,
      '飞书应用凭据或配置不可用，请重新扫码登录并绑定应用。',
    );
  }

  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|socket|网络/i.test(text)) {
    return recovery(
      'LARK_NETWORK_UNAVAILABLE',
      'retry',
      false,
      '连接飞书服务失败，请检查网络后重试。',
    );
  }

  return recovery(
    'LARK_AUTHORIZATION_PENDING',
    'authorize',
    false,
    '飞书网页可能已完成配置，但本地尚未收到最终应用凭据。原绑定已保留；请检查网络后重新获取二维码并扫码确认。',
  );
}
