import {test,expect} from '@playwright/test';

test('PRD4632 同名根目录切换更新公司链接，空目录清空卡片，迟到刷新不覆盖',async({page})=>{
 let root='A',hold=false,release,started,finished;
 const gate=new Promise(r=>release=r),observed=new Promise(r=>started=r),done=new Promise(r=>finished=r);
 const settings=()=>({rootName:'行研工作台',folderToken:'Root'+root,folderUrl:'https://example.feishu.cn/drive/folder/Root'+root});
 const cards=which=>({companies:which==='C'?[]:[{name:'后摩智能',url:'https://example.feishu.cn/docx/'+which,dimensions:['技术路线'],added:1,conflicts:0,updatedAt:'2026-11-06T00:00:00Z'},...(which==='A'?[{name:'旧目录公司',url:'https://example.feishu.cn/docx/OldOnly',dimensions:[],added:0,conflicts:0,updatedAt:'2026-11-06T00:00:00Z'}]:[])]});
 await page.route('**/api/config',r=>r.fulfill({json:{mode:'native',cloudOnly:true,analysisAvailable:true,feishuRoot:settings(),publicationScope:root}}));
 await page.route('**/api/industry/library*',async r=>{const requested=root;if(new URL(r.request().url()).searchParams.has('refresh')&&hold){started();await gate;await r.fulfill({json:cards(requested)});finished();}else await r.fulfill({json:cards(requested)});});
 await page.route('**/api/analysis/reports*',r=>r.fulfill({json:{reports:[]}}));
 await page.route('**/api/feishu-settings/import',async r=>{root=JSON.parse(r.request().postData()).folderUrl.endsWith('RootB')?'B':'C';await r.fulfill({json:{settings:settings(),library:cards(root),import:{status:root==='C'?'empty':'completed',message:'已同步当前目录'}}});});
 try{
  await page.goto('/');await expect(page.locator('.industry-company')).toHaveCount(2);
  hold=true;await page.getByRole('button',{name:'刷新列表',exact:true}).click();await observed;
  async function change(next){await page.getByRole('button',{name:'设置飞书根目录',exact:true}).click();const d=page.getByRole('dialog');await d.getByLabel('使用文件夹链接').check();await d.getByLabel('飞书文件夹链接').fill('https://example.feishu.cn/drive/folder/Root'+next);await d.getByRole('button',{name:'保存设置并导入',exact:true}).click();await expect(d).toHaveCount(0);}
  await change('B');await expect(page.locator('.industry-company')).toHaveCount(1);await expect(page.getByRole('link',{name:'后摩智能',exact:true})).toHaveAttribute('href','https://example.feishu.cn/docx/B');
  release();await done;hold=false;await page.evaluate(()=>new Promise(requestAnimationFrame));
  await expect(page.getByRole('link',{name:'后摩智能',exact:true})).toHaveAttribute('href','https://example.feishu.cn/docx/B');
  await expect(page.getByRole('link',{name:'旧目录公司',exact:true})).toHaveCount(0);
  await change('C');await expect(page.locator('.industry-company')).toHaveCount(0);await expect(page.getByRole('heading',{name:'从第一轮调研开始积累'})).toBeVisible();
 }finally{release();}
});
