import {existsSync} from 'node:fs';
import {resolve,delimiter} from 'node:path';
import {homedir} from 'node:os';
export function larkLaunch(command,args,{platform=process.platform,env=process.env,home=homedir(),isFile=existsSync,resolvePath=resolve}={}) {
 if (/\.[cm]?js$/i.test(command)) return {command:process.execPath,args:[command,...args]};
 const native=platform==='win32'&&!/\.exe$/i.test(command)&&(command==='lark-cli'||/(^|[\\/])lark-cli$/i.test(command)||/\.(cmd|ps1)$/i.test(command));
 if(!native)return{command,args};
 const key=Object.keys(env).find(k=>k.toLowerCase()==='path');
 const prefixes=[resolvePath(home,'.local','bin'),...(env[key]??'').split(delimiter),...(env.APPDATA?[resolvePath(env.APPDATA,'npm')]:[])];
 const explicit=/[\\/]/.test(command)&&!/\.(cmd|ps1)$/i.test(command)?[command+'.exe']:[];
 const exe=[...explicit,...prefixes.flatMap(p=>[resolvePath(p,'lark-cli.exe'),resolvePath(p,'node_modules/@larksuite/cli/bin/lark-cli.exe')])].find(isFile);
 if(!exe)throw new Error('找不到 Lark CLI 原生可执行文件');
 return{command:exe,args};
}
