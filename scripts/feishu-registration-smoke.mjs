// This test requests a verification QR, then cancels. It never scans, creates an app or saves credentials.
import { FeishuBinding } from '../server/feishu-binding.mjs';
const binding = new FeishuBinding({ store: { setting() { return { mode: 'default' }; }, saveSetting() { throw new Error('真实二维码验证禁止保存配置'); } } });
try {
  binding.registration.start(); const end = Date.now() + 35000;
  while (Date.now() < end && binding.registration.snapshot().status === 'initializing') await new Promise(r => setTimeout(r, 200));
  const state = binding.registration.snapshot();
  if (state.status !== 'awaiting_scan') throw new Error('官方 SDK 未生成有效二维码');
  let bytes;
  for (let i = 0; i < 30; i++) { try { bytes = binding.registration.qr(state.flowId); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  if (!bytes) throw new Error('本机 Lark CLI 未生成有效 PNG');
  console.log(JSON.stringify({ officialSdk: true, verificationHost: new URL(state.authorizationUrl).host, verificationPath: new URL(state.authorizationUrl).pathname, qrBytes: bytes.length }));
  binding.registration.cancel(); console.log('PASS: 已取消官方二维码验证，未扫码、未创建应用、未改动原配置');
} catch { console.error('FAIL: 官方应用绑定二维码验证失败，请检查网络和 Lark CLI 配置'); process.exitCode = 1; }
finally { binding.close(); }
