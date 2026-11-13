import {existsSync} from 'node:fs';
import {resolve,delimiter} from 'node:path';
import {homedir} from 'node:os';
export function larkLaunch(command,args,{platform=process.platform,env=process.env,home=homedir(),isFile=existsSync,resolvePath=resolve}={}) {
 if (/\.[cm]?js$/i.test(command)) return {command:process.execPath,args:[command,...args]};
 const native=platform==='win32'&&!/\.exe$/i.test(command)&&(command==='lark-cli'||/(^|[\\/])lark-cli$/i.test(command)||/\.(cmd|ps1)$/i.test(command));
 if(!native){
  if(platform!=='win32'&&command==='lark-cli'){
   const pathKey=Object.keys(env).find(k=>k.toLowerCase()==='path');
   const executable=[resolvePath(home,'.local','bin','lark-cli'),...(env[pathKey]??'').split(':').filter(Boolean).map(p=>resolvePath(p,'lark-cli'))].find(isFile);
   if(executable)return{command:executable,args};
  }
  return{command,args};
 }
 const key=Object.keys(env).find(k=>k.toLowerCase()==='path');
 const explicitPath=/[\\/]/.test(command);
 const shim=/\.(cmd|ps1)$/i.test(command);
 const shimDir=explicitPath&&shim?(resolvePath(command,'..')):null;
 const prefixes=shimDir?[shimDir]:[resolvePath(home,'.local','bin'),...(env[key]??'').split(platform==='win32'?';':delimiter).filter(Boolean),...(env.APPDATA?[resolvePath(env.APPDATA,'npm')]:[])];
 const explicit=explicitPath&&!shim?[command+'.exe']:[];
 if(explicitPath&&!shim){if(isFile(explicit[0]))return{command:explicit[0],args};throw Object.assign(new Error('找不到 Lark CLI 指定可执行文件，请检查安装路径'),{code:'ENOENT'});}
 const exe=[...explicit,...prefixes.flatMap(p=>[resolvePath(p,'lark-cli.exe'),resolvePath(p,'node_modules/@larksuite/cli/bin/lark-cli.exe')])].find(isFile);
 if(!exe)throw Object.assign(new Error('找不到 Lark CLI 原生可执行文件，请安装官方 CLI 后重新检测'),{code:'ENOENT'});
 return{command:exe,args};
}
