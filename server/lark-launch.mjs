import {existsSync} from 'node:fs';
import {resolve,delimiter} from 'node:path';
export function larkLaunch(command,args) {
 if (/\.[cm]?js$/i.test(command)) return {command:process.execPath,args:[command,...args]};
 if(command !== 'lark-cli' && !/\.(cmd|ps1)$/i.test(command))return{command,args};
 if(process.platform!=='win32'||/\.exe$/i.test(command))return{command,args};
 const key=Object.keys(process.env).find(k=>k.toLowerCase()==='path');
 const prefixes=[...(process.env[key]??'').split(delimiter),resolve(process.env.APPDATA??'', 'npm')];
 const exe=prefixes.flatMap(p=>[resolve(p,'lark-cli.exe'),resolve(p,'node_modules/@larksuite/cli/bin/lark-cli.exe')]).find(existsSync);
 if(!exe)throw new Error('找不到 Lark CLI 原生可执行文件');
 return{command:exe,args};
}
