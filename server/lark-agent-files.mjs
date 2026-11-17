import { copyFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { larkLaunch } from './lark-launch.mjs';

export function prepareLarkAgent(meta, command) {
  if (!command) return;
  const directory = meta.writeGuard ? resolve(meta.cwd, `lark-${meta.id}`) : meta.cwd;
  mkdirSync(directory, {recursive:true});
  for (const name of ['lark-agent-client.mjs', 'lark-launch.mjs', 'lark-write-policy.mjs']) copyFileSync(new URL(name, import.meta.url), resolve(directory, name));
  let launch;
  try { launch = larkLaunch(command, []); } catch { launch = { command, args: [] }; }
  writeFileSync(resolve(directory, 'lark-agent-config.json'), JSON.stringify({...launch, managedFolders: meta.workflow === 'cloud-only', ...(meta.writeGuard ? {writeGuard:meta.writeGuard} : {})}));
  meta.larkClientPath = resolve(directory, 'lark-agent-client.mjs');
}
