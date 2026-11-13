// Executed by the native Agent after research and immediately before any cloud
// mutation. Keep waiting here; never fall back to an unlocked write on failure.
import {readFileSync} from 'node:fs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
const {url}=JSON.parse(readFileSync(config.endpointFile,'utf8'));
const response=await fetch(url+'/api/tasks/'+config.taskId+'/write-lock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:config.requestId})});
const value=await response.json();
if(!response.ok)throw new Error(value.error??'无法获取保存锁');
console.log(JSON.stringify(value));
