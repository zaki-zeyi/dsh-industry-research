import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { url } = JSON.parse(readFileSync(config.endpointFile, 'utf8'));
const response = await fetch(url + '/api/tasks/' + config.taskId + '/queued-save', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    requestId: config.requestId,
    terminalId: config.terminalId,
    input: JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, '')),
  }),
});
const result = await response.json();
if (!response.ok) {
  console.error(result.error ?? '保存提交失败');
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result));
}
