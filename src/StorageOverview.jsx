import React from 'react';
import { FolderOpen } from 'lucide-react';

export function StorageOverview({path,description,syncedAt,action,children}){
  return <section className="storage-overview briefing-overview" aria-label="存储位置">
    <div className="storage-overview-main">
      <span className="storage-overview-icon" aria-hidden="true"><FolderOpen size={21}/></span>
      <div className="storage-overview-location"><span>存储位置</span><strong>{path}</strong><p>{description}</p></div>
    </div>
    <div className="storage-overview-aside">
      <div className="storage-overview-sync"><span>上次同步</span><time dateTime={syncedAt??undefined}>{syncedAt?new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Shanghai'}).format(new Date(syncedAt)):'等待同步'}</time></div>
      {action}
    </div>
    {children&&<div className="storage-overview-details">{children}</div>}
  </section>;
}
