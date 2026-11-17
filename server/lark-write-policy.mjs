// Explicit read-only command shapes. Argument values such as a title "get"
// must never turn an unknown/mutating operation into an unlocked read.
export function isReadOnlyLarkRequest(args) {
  if(args.length===1&&['--help','-h','--version'].includes(args[0]))return true;
  const services=new Set(['docs','drive','wiki','sheets','base','search','auth','skills','config']);
  let index=0;
  while(index<args.length&&args[index].startsWith('--')){
    if(!['--profile','--app','--as','--format'].includes(args[index]))return false;
    index+=2;
  }
  const service=args[index],verb=args[index+1];if(!services.has(service))return false;
  if(['--help','-h'].includes(verb)||args.length===index+3&&['--help','-h'].includes(args[index+2]))return true;
  if(service==='skills')return ['read','list'].includes(verb);
  if(service==='auth')return ['status','whoami'].includes(verb);
  if(service==='config')return ['get','list'].includes(verb);
  return ['+fetch','+get','+list','+search','+download'].includes(verb);
}
