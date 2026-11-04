# 插件卸载与共享组件归属

0.6.4 起，行研包的 cordis.patch.yml 仅注册 dsh-industry-research，不再声明官方 schedule 行。宿主的官方调度按需通过 ctx.get('schedule') 复用；未开启官方调度时普通工作台仍可加载，保存定时配置会明确提示服务未启用。

旧包曾声明与官方组件相同的 schedule ID 和 name。宿主 removeBundle 在停用组合包后检查这些声明是否仍有运行实例，因官方 Schedule 仍在使用而返回 bundle-in-use。

旧包修复：在新版源码目录运行 node scripts/repair-legacy-schedule-reference.mjs --package-root <旧行研包目录>，再在宿主插件管理中卸载。修复工具仅接受原始两条组件声明，先备份，再移除旧行研包的 schedule 声明；不会改写宿主 profile、关闭官方调度或删除任务数据。遇到其他定制声明会拒绝改写。

本次已修复桌面版链接的 0.6.2 包声明。卸载重试后，桌面 profile 的依赖和锁文件均已不再包含 dsh-industry-research；业务数据目录保留。

验证：172 项服务测试通过，其中新增包归属、旧包修复幂等/备份/拒绝定制配置、宿主调度按需可用性回归。0.6.4 发布包检查通过。发布包独立运行时验收未完成，本机终端验收进程无输出，已停止；不将其计作通过。
