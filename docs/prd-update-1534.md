# PRD1534 实现记录

来源：https://zcnnosk3k1j9.feishu.cn/wiki/LiujwLZvIirk8akSjyVcr0Axn4g

FR04 从单份逐字稿扩展到原始资料、逐字稿、会议纪要与公司信息库增量更新。目录名按任务快照保存并持久化默认值，目录token按飞书应用、根目录和内部目录隔离。所有远端写入仍由宿主原生Agent完成，保存前获取现有共享锁并刷新目录及公司索引快照。

新增回执字段 materialFolderToken、minutesFolderToken、minutesUrl。新任务版本为1534，要求双文档与完整目录交付，有公司命中时要求公司索引回执，无命中必须显式回传companies空数组。旧任务不强制升级交付要求。部分文档链接和目录保存供重试，禁止盲目重建。

ASR质量、纪要质量、来源核验及实际上传续传能力需要真实资料及真实DSH模型验收；自动化验收使用模型/飞书夹具，不等同于生产内容验收。
