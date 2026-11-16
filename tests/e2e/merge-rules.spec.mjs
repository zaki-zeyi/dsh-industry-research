import { test, expect } from '@playwright/test';

test('迁移后的PRD：日报周报和内部资料弹窗展示完整合并规则，仍可编辑研究要求',async({page})=>{
  await page.goto('/');
  for(const label of ['日报','周报']){
    await page.getByRole('button',{name:label,exact:true}).click();
    for(const mode of ['手动','定时']){
      await page.getByRole('button',{name:mode+'生成'+label,exact:true}).click();
      const dialog=page.getByRole('dialog'),prompt=dialog.getByLabel('任务 Prompt',{exact:false});
      await expect(prompt).toHaveValue(/【全量信息库合并规则】/);
      await expect(prompt).toHaveValue(/重复、补充、状态更新、冲突、新增/);
      await expect(prompt).toHaveValue(/禁止把本次调研摘要整体追加到公司文档/);
      await dialog.getByLabel('其他要求',{exact:true}).fill('特别保留融资历史与人工备注');
      await expect(prompt).toHaveValue(/特别保留融资历史与人工备注/);
      await expect(prompt).toHaveValue(/必须先完整读取目标公司文档/);
      await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
    }
  }
  await page.getByRole('button',{name:'内部资料',exact:true}).click();
  await page.getByRole('button',{name:'解析内部资料',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel('网络链接').check();await dialog.getByLabel('网络资料链接').fill('https://example.com/interview.mp4');
  await dialog.getByLabel('其他要求',{exact:true}).fill('保留所有来源和冲突双方');
  await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/保留所有来源和冲突双方/);
  await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/维度—条目—事实—时间—来源/);
  await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/修改完成后重新读取受影响的章节/);
  await page.keyboard.press('Escape');
});
