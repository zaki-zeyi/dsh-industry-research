import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuBinding, requiredScopes } from '../server/feishu-binding.mjs';

test('合并后保留首次导入权限，但缺少目录列表权限不阻断绑定和调研',async()=>{
  const binding=new FeishuBinding({run:async()=>({appId:'cli_merge123',identities:{user:{available:true,verified:true,openId:'ou_merge',scope:requiredScopes.filter(s=>s!=='space:document:retrieve').join(' ')},bot:{available:true,verified:true}}})});
  try{const state=await binding.requireBound();assert.equal(state.bound,true);assert.equal(state.importReady,false);assert.equal(state.openId,'ou_merge');assert.ok(binding.scopes.includes('space:document:retrieve'));}
  finally{binding.close();}
});
