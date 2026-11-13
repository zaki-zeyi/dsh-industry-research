# PRD1557 发布结果 · v0.5.1

- 全量Node157/157、Edge9/9通过。新增5项文件导入接口测试及2项浏览器流程测试。
- 真实tgz安装到独立prd1557-check Profile，官方dump-config确认插件注册。基于官方web模板启动隔离宿主，并使用独立业务数据目录与demo模式；通过Edge实际打开安装包页面，验证下级历史导航、选择中文文件、显示所选文件和取消弹窗。未发起真实模型任务。截图保存在本机artifacts/prd1557-real-host-picker.png，未纳入仓库。
- 使用桌面版自带CLI、offline模式将desktop Profile更新为artifacts/dsh-industry-research-0.5.1，读取已安装package.json确认版本0.5.1。未关闭用户桌面应用或重启其会话；重开工作台或重启DSH使用新版。
- 生产音视频转写与飞书远端内容写入未验收。文件实际字节导入、可读取路径与超限/中断清理已通过自动测试。
