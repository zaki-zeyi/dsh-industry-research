import { runLark } from './lark-cli.mjs';
import { classifyFeishuError } from './feishu-monitor.mjs';

export const CLI_INSTALL = Object.freeze({
  documentationUrl: 'https://github.com/larksuite/cli#installation--quick-start',
  nodeUrl: 'https://nodejs.org/en/download',
  windowsCommand: 'npx.cmd --yes @larksuite/cli@latest install',
  unixCommand: 'npx --yes @larksuite/cli@latest install',
});

// Read-only probe. It neither configures an app nor requests/revokes user auth.
export async function inspectLarkCli(command, { run, platform = process.platform } = {}) {
  const common = { platform, install: CLI_INSTALL };
  try {
    const response = await runLark(command, ['--version'], { timeout: 5000, maxBuffer: 16384 }, run);
    const version = /\b(?:v)?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/.exec(response.stdout ?? '')?.[1];
    if (!version) return { ...common, status: 'unavailable', code: 'CLI_INVALID_RESPONSE', message: 'CLI 已启动，但版本响应无法识别，请检查指定的命令或修复安装' };
    return { ...common, status: 'ready', code: 'OK', version, message: '飞书 CLI 可用；账号授权状态请在飞书绑定或连接检测中查看' };
  } catch (error) {
    const code = classifyFeishuError(error), missing = error.code === 'ENOENT' || code === 'CLI_NOT_FOUND';
    return { ...common, status: missing ? 'missing' : 'unavailable', code: missing ? 'LARK_CLI_NOT_FOUND' : code,
      message: missing ? '未找到飞书 CLI，请安装官方 CLI；已安装时请检查指定路径后重新检测' : '飞书 CLI 无法正常启动，请检查安装、执行权限或超时后重新检测' };
  }
}
