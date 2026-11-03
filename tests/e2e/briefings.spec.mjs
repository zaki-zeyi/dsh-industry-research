import {test,expect} from '@playwright/test';
test('FR02 日报周报入口、可编辑任务、报告卡片、续聊和独立历史',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'日报',exact:true}).click();
 await expect(page.getByRole('heading',{name:'日报',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'手动生成日报',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/同时自动去重增量保存/);
 await dialog.getByRole('button',{name:'启动',exact:true}).click();await expect(page.getByRole('button',{name:'← 返回工作台'})).toBeVisible();await page.getByRole('button',{name:'← 返回工作台'}).click();
 await expect(page.getByRole('link',{name:'打开飞书日报'})).toHaveAttribute('href',/feishu.cn\/docx\//);await expect(page.getByText('本日无更新')).toBeVisible();
 await page.getByRole('button',{name:'AI 会话详情'}).click();await expect(page.getByRole('button',{name:'← 返回工作台'})).toBeVisible();await page.getByRole('button',{name:'← 返回工作台'}).click();
 await page.getByRole('button',{name:'周报',exact:true}).click();await expect(page.getByText(/前七个完整自然日/)).toBeVisible();await expect(page.getByRole('heading',{name:'暂无周报记录'})).toBeVisible();
 await page.getByRole('button',{name:'定时生成周报'}).click();const settings=page.getByRole('dialog');await expect(settings.getByLabel('发送时间（北京时间）')).toHaveValue('09:00');await settings.getByLabel('发送时间（北京时间）').fill('09:15');await settings.getByLabel('启用此定时任务').check();await settings.getByRole('button',{name:'完成',exact:true}).click();await expect(settings).toHaveCount(0);
 await page.getByRole('button',{name:'定时生成周报'}).click();await expect(page.getByRole('dialog').getByLabel('发送时间（北京时间）')).toHaveValue('09:15');await page.getByRole('dialog').getByRole('button',{name:'关闭调研配置'}).click();
 await page.getByRole('button',{name:'日报',exact:true}).click();await page.getByRole('button',{name:'定时生成日报'}).click();await expect(page.getByRole('dialog').getByLabel('发送时间（北京时间）')).toHaveValue('09:00');await page.getByRole('dialog').getByRole('button',{name:'关闭调研配置'}).click();await page.getByRole('button',{name:'周报',exact:true}).click();
 await page.screenshot({path:'artifacts/fr02-weekly.png',fullPage:true});
});
