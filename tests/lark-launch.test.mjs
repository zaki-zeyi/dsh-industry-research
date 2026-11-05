import test from 'node:test';
import assert from 'node:assert/strict';
import { win32, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { FeishuBinding } from '../server/feishu-binding.mjs';
import { larkLaunch } from '../server/lark-launch.mjs';

test('Windows 不在PATH的用户目录飞书原生exe可被定位', () => {
  const home = 'C:\\Users\\测试用户', exe = win32.resolve(home, '.local/bin/lark-cli.exe');
  const args = ['profile', 'list'];
  assert.deepEqual(larkLaunch('lark-cli', args, { platform:'win32', env:{Path:'C:\\Windows'}, home, isFile:p=>p===exe, resolvePath:win32.resolve }), { command:exe, args });
});
test('Windows 显式无扩展路径补全exe，参数不经过shell', () => {
  const command='D:\\工具 & 程序\\lark-cli', args=['auth','qrcode','https://example.feishu.cn/?code=1&state=2','--output','D:\\中文 & 空格\\qr.png'];
  assert.deepEqual(larkLaunch(command,args,{platform:'win32',env:{},home:'C:\\Users\\user',isFile:p=>p===command+'.exe',resolvePath:win32.resolve}),{command:command+'.exe',args});
});
test('Windows npm shim使用原生exe，缺失时明确失败', () => {
  const root='C:\\工具\\npm', exe=win32.resolve(root,'node_modules/@larksuite/cli/bin/lark-cli.exe');
  const options={platform:'win32',env:{Path:root},home:'C:\\Users\\user',resolvePath:win32.resolve};
  for(const name of ['lark-cli.cmd','lark-cli.ps1']) assert.equal(larkLaunch(win32.resolve(root,name),[],{...options,isFile:p=>p===exe}).command,exe);
  assert.throws(()=>larkLaunch('lark-cli',[],{...options,isFile:()=>false}),/找不到 Lark CLI/);
});
test('显式exe、macOS和Node脚本保留正确启动方式', () => {
  const args=['auth','status','--json'];
  assert.deepEqual(larkLaunch('D:\\工具\\lark-cli.exe',args,{platform:'win32'}),{command:'D:\\工具\\lark-cli.exe',args});
  assert.deepEqual(larkLaunch('/opt/bin/lark-cli',args,{platform:'darwin'}),{command:'/opt/bin/lark-cli',args});
  assert.deepEqual(larkLaunch('D:\\fake-cli.mjs',args),{command:process.execPath,args:['D:\\fake-cli.mjs',...args]});
});

test('绑定服务实际经过启动器，CLI标准输出错误保留用于重复App ID恢复', async () => {
  const dir=mkdtempSync(join(tmpdir(),'lark-launch-')), file=join(dir,'模拟 CLI & test.mjs');
  writeFileSync(file,"process.stdout.write('each profile must have a unique app-id');process.stderr.write('fixture diagnostic');process.exit(2);");
  const binding=new FeishuBinding({command:file});
  try {
    await assert.rejects(binding.run(['profile','add']), error=>error.code===2&&error.stdout.includes('unique app-id')&&error.stderr.includes('fixture diagnostic'));
  } finally { binding.close(); rmSync(dir,{recursive:true,force:true}); }
});
