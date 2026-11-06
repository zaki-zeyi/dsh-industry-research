import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { runLark } from '../server/lark-cli.mjs';
import { larkLaunch } from '../server/lark-launch.mjs';
import { inspectLarkCli } from '../server/lark-setup.mjs';
import { prepareLarkAgent } from '../server/lark-agent-files.mjs';
import { cliFor } from '../server/feishu-application.mjs';
import { FeishuBinding, requiredScopes } from '../server/feishu-binding.mjs';
import { refreshLibrary, libraryKey } from '../server/industry.mjs';
import { refreshAnalysisLibrary, analysisKey } from '../server/analysis.mjs';
import { cloudPublications } from '../server/cloud-publications.mjs';
import { FeishuDirectories } from '../server/feishu-directories.mjs';
import { Store } from '../server/store.mjs';
import { cloudPrompt } from '../server/cloud-research.mjs';
import { uploadPrompt } from '../server/upload-prompt.mjs';
import { createApp } from '../server/app.mjs';
import { fixture as serviceFixture } from './helpers.mjs';
import { NativeSessions } from '../server/native-sessions.mjs';
import { mockHost } from './fixtures/fake-native-host.mjs';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const app = { mode: 'custom', profile: 'selected', appId: 'cli_selected123' };
const root = { rootName: '行研工作台', folderToken: 'Root' };
const url = name => `https://tenant.feishu.cn/docx/${name}`;
function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), "全局 CLI & 'quoted'-")), command = resolve(dir, 'fake-cli.mjs');
  const store = new Store(resolve(dir, 'store.sqlite'));
  const identity = { appId: app.appId, identities: { user: { available: true, verified: true, userName: '测试用户', openId: 'ou_test123', scope: requiredScopes.join(' ') } } };
  const company = { name: '测试公司', url: url('Company'), dimensions: ['技术路线'], updatedAt: '2026-11-06T01:00:00Z', conflicts: 0, added: 1 };
  writeFileSync(command, `
import {readFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2);appendFileSync(new URL('./calls.jsonl',import.meta.url),JSON.stringify(args)+'\\n');
if(args.includes('--version')){console.log('lark-cli 1.2.3');process.exit(0);}
if(args.includes('echo-stdin')){let input='';for await(const chunk of process.stdin)input+=chunk;console.log(JSON.stringify({ok:true,data:{input,cwd:process.cwd(),args}}));process.exit(0);}
if(args[0]!=='--profile'||args[1]!=='selected')throw Error('Wrong profile');
const emit=data=>console.log(JSON.stringify({ok:true,data}));
if(args.includes('status'))console.log(JSON.stringify(${JSON.stringify(identity)}));
else if(args.includes('+fetch'))emit({document:{content:JSON.stringify(args.includes(${JSON.stringify(url('AnalysisIndex'))})?{reports:[]}:{companies:[${JSON.stringify(company)}]})}});
else if(args.includes('list')){
 const name=args[args.indexOf('--folder-token')+1];
 const entries={Root:[['全量信息库','Library'],['日报','Daily'],['周报','Weekly'],['内部资料','Internal'],['友商分析','Analysis']],Internal:[['逐字稿','Transcript'],['原始资料','Sources'],['会议纪要','Minutes']]};
 const files=(entries[name]??[]).map(([name,token])=>({name,token,type:'folder'}));
 if(['Daily','Weekly','Transcript'].includes(name))files.push({name:'历史报告',token:'Report',type:'docx',url:${JSON.stringify(url('Report'))}});
 if(name==='Analysis')files.push({name:'分析报告索引',token:'AnalysisIndex',type:'docx',url:${JSON.stringify(url('AnalysisIndex'))}});
 emit({files,has_more:false});
}else throw Error('Unexpected command');
`);
  return { dir, command, store, company, calls: () => readFileSync(resolve(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse),
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('全量库、友商分析、日报、周报、内部资料、目录解析与认证共用真实CLI子进程', async () => {
  const f = fixture(), binding = new FeishuBinding({ command: f.command, store: f.store });
  try {
    f.store.saveSetting(libraryKey(root, app), { rootFolderToken: 'Root', folderToken: 'Library', manifestUrl: url('Index'), companies: [] });
    f.store.saveSetting(analysisKey(root, app), { folderToken: 'Analysis', manifestUrl: url('AnalysisIndex'), reports: [] });
    assert.equal((await refreshLibrary(f.store, root, app, undefined, { command: f.command })).companies[0].name, '测试公司');
    assert.deepEqual((await refreshAnalysisLibrary(f.store, root, app, undefined, { command: f.command })).reports, []);
    const service = { store: f.store, binding, cloudOnly: true, feishuSettings: () => root };
    binding.applicationSnapshot = () => app;
    for (const kind of ['daily', 'weekly', 'internal']) {
      const result = await cloudPublications(service, kind, { refresh: true });
      assert.equal(result.items.length, 1, kind); assert.equal(result.items[0].publication.url, url('Report'));
    }
    const directories = new FeishuDirectories(f.store, { command: f.command });
    const t = { id: 'test', feishuRoot: { ...root }, feishuApp: app, analysis: {} }; await directories.prepare(t);
    assert.equal(t.analysisIndex.folderToken, 'Analysis'); assert.equal((await binding.status(app)).bound, true);
    assert.ok(f.calls().every(a => a[0] === '--profile' && a[1] === 'selected'));
    assert.ok(!f.calls().some(a => a.includes('+create-folder')));
  } finally { binding.close(); f.close(); }
});

test('统一执行器保留stdin、cwd与原始退出信息，不使用shell', async () => {
  const f = fixture();
  try {
    const result = JSON.parse((await runLark(f.command, ['echo-stdin', '&', 'spaces here'], { input: 'test-input\n', cwd: f.dir })).stdout);
    assert.equal(result.data.input, 'test-input\n'); assert.equal(result.data.cwd, f.dir); assert.deepEqual(result.data.args, ['echo-stdin', '&', 'spaces here']);
    await assert.rejects(runLark(f.command, ['unsupported']), e => e.code !== 0 && /Wrong profile/.test(e.stderr));
  } finally { f.close(); }
});

test('会话启动器与后端使用同一命令，cwd变化仍能找到配置并保留stdin/退出码', async () => {
  const f = fixture();
  try {
    const meta = { cwd: f.dir }; prepareLarkAgent(meta, f.command);
    const result = await runLark(meta.larkClientPath, ['echo-stdin', '@./relative.md'], { input: 'report-input', cwd: tmpdir() });
    const data = JSON.parse(result.stdout).data;
    assert.equal(data.input, 'report-input'); assert.equal(data.cwd, tmpdir()); assert.equal(data.args[1], '@./relative.md');
    const config = JSON.parse(readFileSync(resolve(f.dir, 'lark-agent-config.json'), 'utf8'));
    assert.equal(config.command, process.execPath); assert.deepEqual(config.args, [f.command]);
    const noPath = await exec(process.execPath, [meta.larkClientPath, '--version'], { env: { ...process.env, PATH: '', Path: '' } });
    assert.match(noPath.stdout, /1\.2\.3/);
    writeFileSync(resolve(f.dir, 'exit-cli.mjs'), "process.stderr.write('fixture error');process.exit(10)");
    prepareLarkAgent(meta, resolve(f.dir, 'exit-cli.mjs'));
    await assert.rejects(exec(process.execPath, [meta.larkClientPath, 'auth']), e => e.code === 10 && e.stderr === 'fixture error');
    const text = readFileSync(resolve(f.dir, 'lark-agent-config.json'), 'utf8'); assert.ok(!/secret|token/i.test(text));
  } finally { f.close(); }
});

test('原生会话创建时真正写入统一启动器，重试和旧上传也刷新所用CLI', async () => {
  const f = fixture(), sessions = new NativeSessions(f.store, mockHost(), { workRoot: resolve(f.dir, 'sessions') });
  sessions.larkCommand = f.command;
  try {
    const t = { id: randomUUID(), direction: '测试调研', prompt: '调研', cloudOnly: true, feishuRoot: root, feishuApp: app };
    const first = await sessions.create(t); t.terminalId = first.id;
    assert.ok(readFileSync(first.promptPath, 'utf8').includes(cliFor(app, first)));
    assert.match((await exec(process.execPath, [first.larkClientPath, '--version'])).stdout, /1\.2\.3/);
    const second = await sessions.create(t); assert.equal(second.sessionId, first.sessionId);
    t.terminalId = second.id; t.report = { title: '已有报告', summary: '摘要', markdown: '正文', sources: [] };
    const upload = sessions.queueUpload(t, randomUUID());
    assert.ok(readFileSync(upload.pendingPromptPath, 'utf8').includes(cliFor(app, upload)));
    assert.ok(!readFileSync(upload.pendingPromptPath, 'utf8').includes('lark-cli --profile'));
  } finally { sessions.close(); f.close(); }
});

test('所有任务与旧上传提示词固定到会话启动器及所选profile', () => {
  const meta = { larkClientPath: "C:/test $()/a 'quoted'/lark-agent-client.mjs", deliveryPath: 'receipt', deliveryRequestId: 'request', qrPath: 'qr.png' };
  const base = { id: 'task', direction: '测试任务', prompt: '调研', feishuApp: app, feishuRoot: root, report: { title: '标题' } };
  for (const extra of [{}, { industry: {} }, { analysis: { companies: [], dimensions: [] } }, { briefing: { kind: 'weekly', window: {} } }, { internal: { sourceType: 'url' } }]) {
    const prompt = cloudPrompt({ ...base, ...extra }, meta); assert.ok(prompt.includes(cliFor(app, meta)));
    assert.ok(!prompt.includes('lark-cli --profile'));
  }
  assert.ok(uploadPrompt(base, meta, 'request', 'report.md').includes(cliFor(app, meta)));
});

test('Windows的会话命令可执行含中文、空格、&和单引号的路径', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  try {
    const meta = { cwd: f.dir }; prepareLarkAgent(meta, f.command);
    const command = cliFor(undefined, meta) + ' --version';
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
    assert.match(stdout, /1\.2\.3/);
  } finally { f.close(); }
});

test('显式Windows无效路径不回退其他CLI，npm shim使用自身目录原生exe', () => {
  const home = 'C:\\Users\\other', other = win32.resolve(home, '.local/bin/lark-cli.exe');
  const options = { platform: 'win32', home, env: {}, resolvePath: win32.resolve, isFile: p => p === other };
  assert.throws(() => larkLaunch('D:\\missing\\lark-cli', [], options), e => e.code === 'ENOENT');
  const local = 'D:\\custom\\lark-cli.exe';
  assert.equal(larkLaunch('D:\\custom\\lark-cli.ps1', [], { ...options, isFile: p => p === local }).command, local);
});

test('环境检测区分未安装、不可运行和可用，不触碰认证或安装', async () => {
  const cases = [
    { run: async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); }, status: 'missing', code: 'LARK_CLI_NOT_FOUND' },
    { run: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }, status: 'unavailable', code: 'TIMEOUT' },
    { run: async () => ({ stdout: 'secret diagnostic, not a version' }), status: 'unavailable', code: 'CLI_INVALID_RESPONSE' },
    { run: async () => ({ stdout: 'lark-cli version v1.2.3' }), status: 'ready', code: 'OK' },
  ];
  for (const c of cases) {
    const result = await inspectLarkCli('/test/cli', { run: async (command, args) => { assert.deepEqual(args, ['--version']); return c.run(); } });
    assert.equal(result.status, c.status); assert.equal(result.code, c.code); assert.ok(!JSON.stringify(result).includes('secret diagnostic'));
    assert.match(result.install.windowsCommand, /^npx\.cmd /);
  }
});

test('环境检测API只读，缺失CLI时二维码登记被阻止而不修改应用绑定', async () => {
  const f = serviceFixture(); let registered = 0;
  const before = { mode: 'custom', appId: 'cli_original' };
  f.service.binding = { command: '/missing/cli', inspectCLI: async () => ({ status: 'missing', code: 'LARK_CLI_NOT_FOUND', message: '未找到 CLI' }),
    registration: { start() { registered++; } }, applicationSnapshot: () => before, close() {} };
  const server = createApp(f.service, { cliRun: async () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); } }).listen(0, '127.0.0.1');
  try {
    await new Promise(done => server.once('listening', done)); const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base + '/api/feishu-cli'); assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal((await response.json()).status, 'missing');
    const post = await fetch(base + '/api/feishu-registration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(post.status, 503); assert.equal((await post.json()).code, 'LARK_CLI_NOT_FOUND');
    assert.equal(registered, 0); assert.deepEqual(f.service.binding.applicationSnapshot(), before);
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); await f.close(); }
});
