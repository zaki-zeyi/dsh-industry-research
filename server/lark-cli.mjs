import { execFile } from 'node:child_process';
import { larkLaunch } from './lark-launch.mjs';

// Backend readers, authentication and native-session helpers share this one
// launch contract. Preserve stdout/stderr for existing safe error classifiers.
export function larkExec(command, args, options = {}) {
  const { input = '', ...execOptions } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, execOptions, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
    child.stdin?.on('error', () => {}); child.stdin?.end(input);
  });
}

export function runLark(command = 'lark-cli', args = [], options = {}, run = larkExec) {
  const launch = run === larkExec ? larkLaunch(command, args) : { command, args };
  return run(launch.command, launch.args, {
    timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true, ...options,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1', ...options.env },
  });
}
