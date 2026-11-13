import { fileURLToPath } from 'node:url';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
export function dshLaunch(meta, settings, { command = 'dsh', platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  if (meta.resumeLast && !meta.resumeId && !meta.collectReport) throw new Error('历史 dsh 终端缺少原生会话 ID，无法自动恢复；报告和历史输出已保留');
  const baseUrl = settings.baseUrl === 'https://api.deepseek.com' ? 'https://api.deepseek.com/anthropic' : settings.baseUrl;
  const patchPath = resolve(meta.cwd, `dsh-${meta.id}.json`);
  const custom = settings.configuration !== 'native' && Boolean(settings.apiKey);
  const patch = [
    ...(custom ? [
      { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      { id: 'tui', config: { defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' }, locale: 'en', providerOnboardingVersion: 1 } },
      { id: 'llm-deepseek-account', disabled: true },
      { id: 'llm-deepseek', config: { baseURL: baseUrl, apiKeyEnv: 'RESEARCH_DSH_API_KEY' } },
    ] : []),
    { id: 'permission', config: { defaultPreset: 'danger-full-access', presets: { 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } } } },
    { insert: [{ id: 'research-terminal-bridge', name: fileURLToPath(new URL('../plugin/dsh-terminal-bridge.mjs', import.meta.url)), config: { sessionPath: meta.sessionPath, completionPath: meta.completionPath } }] },
  ];
  writeFileSync(patchPath, JSON.stringify(patch), { mode: 0o600 });
  const args = ['--profile', 'tui', '--patch', patchPath, ...(meta.resumeId ? ['--resume', meta.resumeId] : [])];
  if (platform !== 'win32' || /\.exe$/i.test(command)) return { command, args };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
  const prefixes = [...(env[pathKey] ?? '').split(delimiter), ...(env.APPDATA ? [resolve(env.APPDATA, 'npm')] : [])];
  const cli = prefixes.map(prefix => resolve(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js')).find(existsSync);
  if (!cli) throw new Error('找不到 Windows dsh CLI，请安装 @deepseek-ai/dsh 和 TUI profile');
  return { command: execPath, args: [cli, ...args] };
}
