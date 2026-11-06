import {test,expect} from '@playwright/test';

for(const kind of ['daily','weekly','internal','industry','analysis'])test('绑定提示定位'+kind+'任务卡片并打开原会话',async({page})=>{
 const id='11111111-2222-4222-8222-333333333333';
 const task={id,direction:kind==='daily'?'日报 · 2026-11-05 00:00 至 23:59':'待完成的'+kind+'任务',status:'failed',createdAt:'2026-11-06T00:00:00Z',sources:'测试信源',runs:[],nativeSession:true,nativeSessionId:'existing-native-session',publication:{status:'publishing'},
  ...(['daily','weekly'].includes(kind)?{briefing:{kind,window:{display:'2026-11-05'}}}:kind==='internal'?{internal:{sourceType:'url',source:'https://example.com/interview',sourceLabel:'访谈',directoryName:'内部资料'}}:kind==='analysis'?{analysis:{companies:['后摩智能','光羽芯辰']}}:{})};
 const blocker={id,title:task.direction,kind,reason:'upload_pending',canOpenSession:true};
 await page.route('**/api/feishu-binding',r=>r.fulfill({json:{bound:true,appId:'cli_fixture123',userName:'测试用户'}}));
 await page.route('**/api/feishu-registration',r=>r.request().method()==='POST'?r.fulfill({status:409,json:{code:'FEISHU_TASKS_BUSY',error:'有调研或上传正在执行，请完成/停止后再重新绑定',blockers:[blocker]}}):r.fulfill({json:{status:'idle'}}));
 await page.route('**/api/tasks?*',r=>r.fulfill({json:{items:[task],nextCursor:null}}));
 await page.route('**/api/tasks/'+id,r=>r.fulfill({json:{task}}));
 await page.route('**/api/briefings?*',r=>r.fulfill({json:{items:['daily','weekly'].includes(kind)?[task]:[]}}));
 await page.route('**/api/internal-materials*',r=>r.fulfill({json:{items:kind==='internal'?[task]:[]}}));
 await page.goto('/');
 await page.getByRole('button',{name:'重新绑定',exact:true}).click();
 const alert=page.getByRole('dialog').getByRole('alert');
 await expect(alert).toContainText('有调研或上传正在执行，请完成/停止后再重新绑定');await expect(alert).toContainText(task.direction);await expect(alert).toContainText('上传待确认');
 if(kind==='daily')await page.screenshot({path:'artifacts/binding-busy-tasks.png',fullPage:true});
 await alert.getByRole('button',{name:'定位卡片'}).click();
 const card=page.locator('#task-card-'+id);await expect(page.getByRole('dialog')).toHaveCount(0);await expect(card).toBeFocused();await expect(card).toHaveClass(/task-card-target/);
 if(kind==='daily')await expect(page.getByRole('heading',{name:'日报',exact:true})).toBeVisible();
 if(['industry','analysis'].includes(kind))await expect(page.getByRole('tab',{name:'历史 AI 任务'})).toHaveAttribute('aria-selected','true');
 await page.getByRole('button',{name:'重新绑定',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'打开会话'}).click();
 await expect(page.getByRole('heading',{name:task.direction,exact:true})).toBeVisible();await expect(page).toHaveURL(new RegExp('#'+id+'$'));
});

test('任务阻塞后可直接重新检查获取二维码，不持续显示正在生成',async({page})=>{
 let attempts=0;
 await page.route('**/api/feishu-binding',r=>r.fulfill({json:{bound:true,appId:'cli_fixture123',userName:'测试用户'}}));
 await page.route('**/api/feishu-registration',r=>{
  if(r.request().method()!=='POST')return r.fulfill({json:{status:'idle'}});
  attempts++;
  return attempts===1?r.fulfill({status:409,json:{code:'FEISHU_TASKS_BUSY',error:'有调研或上传正在执行，请完成/停止后再重新绑定',blockers:[]}}):r.fulfill({json:{status:'awaiting_scan',flowId:'new-flow',authorizationUrl:'https://open.feishu.cn/page/fixture'}});
 });
 await page.goto('/');await page.getByRole('button',{name:'重新绑定',exact:true}).click();
 await expect(page.getByRole('dialog').getByRole('alert')).toContainText('完成/停止');
 await expect(page.getByText('正在生成应用绑定二维码…',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'重新获取应用绑定二维码',exact:true}).click();
 await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);
 await expect(page.getByRole('link',{name:'打开飞书应用绑定页',exact:true})).toBeVisible();expect(attempts).toBe(2);
});
