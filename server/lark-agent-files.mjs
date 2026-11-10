import { copyFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { larkLaunch } from './lark-launch.mjs';

export function prepareLarkAgent(meta, command) {
  if (!command) return;
  for (const name of ['lark-agent-client.mjs', 'lark-launch.mjs']) copyFileSync(new URL(name, import.meta.url), resolve(meta.cwd, name));
  let launch;
  try { launch = larkLaunch(command, []); } catch { launch = { command, args: [] }; }
  writeFileSync(resolve(meta.cwd, 'lark-agent-config.json'), JSON.stringify({...launch, managedFolders: meta.workflow === 'cloud-only'}));
  meta.larkClientPath = resolve(meta.cwd, 'lark-agent-client.mjs');
}
