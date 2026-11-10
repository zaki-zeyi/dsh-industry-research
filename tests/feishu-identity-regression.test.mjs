import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuBinding, requiredScopes } from '../server/feishu-binding.mjs';
const app={mode:'custom',appId:'cli_current123',ownerOpenId:'ou_expected'};
for(const [name,result,bound] of [
 ['同一应用同一账号不要求unionId',{appId:app.appId,openId:'ou_expected'},true],
 ['个人账号不同则拒绝',{appId:app.appId,openId:'ou_other'},false],
 ['应用不同则拒绝',{appId:'cli_other123',openId:'ou_expected'},false],
 ['尚未验证个人授权则拒绝',{appId:app.appId,openId:'ou_expected',verified:false},false],
])test(name,async()=>{const b=new FeishuBinding({run:async()=>({appId:result.appId,identities:{user:{available:true,verified:result.verified??true,openId:result.openId,scope:requiredScopes.join(' ')}}})});try{assert.equal((await b.status(app)).bound,bound);if(!bound)await assert.rejects(b.requireBound(app),e=>e.status===428);}finally{b.close();}});
