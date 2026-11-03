import { test } from 'node:test';
import assert from 'node:assert/strict';
import { larkRecoveryForError, larkRecoveryForStatus } from '../server/lark-health.mjs';

test('飞书授权状态按可恢复原因分类且不暴露底层信息',()=>{
  const base={appId:'cli_fixture123',dpopKeyStatus:'available',identities:{bot:{status:'ready'},user:{available:true,verified:true,tokenStatus:'valid'}}};
  assert.equal(larkRecoveryForStatus(base),null);
  assert.equal(larkRecoveryForStatus({...base,dpopKeyStatus:'missing'}).action,'authorize');
  assert.equal(larkRecoveryForStatus({...base,identities:{...base.identities,user:{...base.identities.user,tokenStatus:'expired'}}}).code,'LARK_USER_AUTH_EXPIRED');
  assert.equal(larkRecoveryForStatus(base,{missingScopes:['docx:document:create']}).code,'LARK_SCOPE_MISSING');
  assert.equal(larkRecoveryForStatus(base,{accountMismatch:true}).code,'LARK_ACCOUNT_MISMATCH');
});

test('本机CLI、PowerShell、DPoP和网络错误得到不同的用户动作',()=>{
  const cases=[
    [Object.assign(new Error('spawn lark-cli ENOENT'),{code:'ENOENT'}),'LARK_CLI_NOT_FOUND','install_cli'],
    [new Error('无法加载文件 lark-cli.ps1，因为在此系统上禁止运行脚本'),'LARK_POWERSHELL_POLICY','repair_cli'],
    [new Error('DPoP key unavailable or inconsistent 0x80090016'),'LARK_DPOP_KEY_UNAVAILABLE','authorize'],
    [new Error('getaddrinfo ENOTFOUND open.feishu.cn'),'LARK_NETWORK_UNAVAILABLE','retry'],
  ];
  for(const [error,code,action] of cases){
    const value=larkRecoveryForError(error);
    assert.equal(value.code,code);
    assert.equal(value.action,action);
    assert.doesNotMatch(value.message,/lark-cli\.ps1|0x80090016|open\.feishu\.cn/i);
  }
});
