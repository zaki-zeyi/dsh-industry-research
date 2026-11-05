import { requiredScopes } from '../../server/feishu-binding.mjs';
import { writeFileSync } from 'node:fs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGQAAAABJRU5ErkJggg==','base64');
export function applicationRunner({defaultBound=true,defaultUserName='默认用户'}={}){
 const calls=[],profiles=new Map(),defaultAccount={appId:'cli_default123',bound:defaultBound,userName:defaultUserName,openId:'ou_scanned',unionId:'on_scanned',logins:[]};let fail=false,mismatch=false,issued=0;
 const run=async(args,options={})=>{
  calls.push({args,options});const profile=args[0]==='--profile'?args[1]:null;const cmd=profile?args.slice(2):args;
  if(cmd[0]==='profile'&&cmd[1]==='list')return [{name:'default',appId:defaultAccount.appId},...Array.from(profiles,([name,a])=>({name,appId:a.appId}))];
  if(cmd[0]==='profile'&&cmd[1]==='add'){if(fail)throw new Error('credential-secret');const appId=cmd[cmd.indexOf('--app-id')+1];if(appId===defaultAccount.appId||[...profiles.values()].some(a=>a.appId===appId))throw Object.assign(new Error('each profile must have a unique app-id'),{code:2});profiles.set(cmd[cmd.indexOf('--name')+1],{appId,bound:false,userName:'自定义用户',openId:'ou_scanned',unionId:'on_scanned',logins:[]});return 'saved';}
  const account=profile?profiles.get(profile):defaultAccount;
  if(!account)throw new Error('missing profile');
  if(cmd[1]==='status')return {appId:mismatch?'cli_wrong123':account.appId,identities:{bot:{status:'ready',available:true,verified:true,appName:profile?'自定义应用':'默认应用'},user:{available:account.bound,verified:account.bound,userName:account.userName,openId:account.openId??'ou_scanned',scope:requiredScopes.join(' ')}}};
  if(cmd[0]==='contact'&&cmd[1]==='+get-user')return {ok:true,data:{user:{open_id:account.openId??'ou_scanned',union_id:account.unionId??'on_scanned'}}};
  if(cmd[1]==='qrcode'){writeFileSync(cmd.at(-1),png);return '';}
  if(cmd.includes('--device-code')){account.bound=true;if(account.logins?.length){const login=account.logins.shift(),value=typeof login==='string'?{openId:login}:login;account.openId=value.openId;account.unionId=value.unionId??`on_${value.openId}`;account.userName=account.openId==='ou_scanned'?'自定义用户':'切换用户';}else if(!profile&&issued>1)account.userName='切换用户';return {success:true};}
  issued++;return {device_code:'private-device-'+issued,verification_url:'https://accounts.feishu.cn/device?code='+(profile?'custom-':'test-')+issued,expires_in:600};
 };
 return {run,calls,profiles,setFail(v){fail=v;},setMismatch(v){mismatch=v;}};
}

export function registrationRunner() {
 const pending=[];let serial=0;
 return {pending,registerApp:async options=>{const id=++serial,url=new URL('https://open.feishu.cn/page/cli');url.searchParams.set('user_code','fixture-'+id);if(options.appId)url.searchParams.set('clientID',options.appId);options.onQRCodeReady({url:url.toString(),expireIn:600});return new Promise((resolve,reject)=>{const request={options,resolve,reject};pending.push(request);options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{code:'abort'})),{once:true});});},approve(appId=null,openId='ou_scanned'){const request=pending.at(-1),clientId=appId??request.options.appId??'cli_scanned123';request.resolve({client_id:clientId,client_secret:'fixture-secret',user_info:{open_id:openId,tenant_brand:'feishu'}});}};
}
