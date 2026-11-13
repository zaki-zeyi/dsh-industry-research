import { createInterface } from 'node:readline';
const send = data => process.stdout.write(`${JSON.stringify({ jsonrpc:'2.0',...data })}\n`);
createInterface({input:process.stdin}).on('line', line => {
  const {id, method, params} = JSON.parse(line);
  if (method==='initialize') return send({id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'test'}}});
  if (method==='session/prompt') { globalThis.sessionId=params.sessionId; return send({id,result:{messageId:'prompt-1'}}); }
  if (method==='session/wait') {
    const report = { title:'协议报告',summary:'这是用于协议兼容性验收的报告摘要。',markdown:'# 协议测试\n\n本报告用于验证 Harness 通知中的助手内容可以被适配器解析，并关联来源记录，属于模拟运行时的协议测试。[S1]',sources:[{id:'S1',title:'测试来源',url:'https://example.com',excerpt:'该摘录仅用于测试协议和报告格式，不是真实研究。'}] };
    send({method:'session.event',params:{sessionId:globalThis.sessionId,event:{type:'assistant/message',seq:1,time:Date.now(),data:{message:{content:[{type:'text',text:JSON.stringify(report)}]}}}}}); return send({id,result:{}});
  }
  if (method==='shutdown') { send({id,result:{}}); process.exit(0); }
});
