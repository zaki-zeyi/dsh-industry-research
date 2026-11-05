import { test, expect } from '@playwright/test';

test('历史报告手动重试成功后展示当前用户通知提醒，失败不冒充已发送',async({page})=>{
  const notice='当前绑定的飞书账号或应用已发生变化，已通过当前应用向当前用户发送通知。';
  let sent=false,attempts=0;
  const task={id:'99999999-9999-4999-8999-999999999999',status:'ready',direction:'历史日报',createdAt:'2026-11-02T01:00:00Z',briefing:{kind:'daily',window:{display:'历史报告'}},publication:{status:'published',url:'https://example.feishu.cn/docx/Report'}};
  const failed={status:'failed',error:'当前绑定已变化'};
  await page.route('**/api/briefings?kind=daily',route=>route.fulfill({json:{items:[{...task,notification:sent?{status:'sent',notice}:failed}]}}));
  await page.route('**/api/briefings/'+task.id+'/notify',route=>{attempts++;sent=attempts>1;return route.fulfill({json:{...task,notification:sent?{status:'sent',notice}:{status:'failed',error:'临时网络异常'}}});});
  await page.goto('/');await page.getByRole('button',{name:'日报',exact:true}).click();
  await page.getByRole('button',{name:'重试通知',exact:true}).click();
  await expect(page.getByText('临时网络异常',{exact:true})).toHaveCount(1);
  await expect(page.getByText(notice,{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'重试通知',exact:true}).click();
  await expect(page.getByText(notice,{exact:true})).toBeVisible();
  await expect(page.getByText('飞书机器人已通知',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'重试通知',exact:true})).toHaveCount(0);
  await page.screenshot({path:'artifacts/notification-current-user.png',fullPage:true});
});
