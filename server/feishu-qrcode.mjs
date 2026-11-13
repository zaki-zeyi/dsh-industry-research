import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { larkRecoveryForError } from './lark-health.mjs';

export const qrcodeOutput = './qrcode.png';
const qrcodeFilename = 'qrcode.png';
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function qrcodePath(directory) {
  return resolve(directory, qrcodeFilename);
}

export function qrcodeArgs(url) {
  return ['auth', 'qrcode', url, '--output', qrcodeOutput];
}

export function qrcodeFailure(cause) {
  if (/^LARK_QRCODE_/.test(String(cause?.code ?? ''))) return cause;
  const recovery = larkRecoveryForError(cause);
  if (['LARK_CLI_NOT_FOUND', 'LARK_POWERSHELL_POLICY', 'LARK_NETWORK_UNAVAILABLE'].includes(recovery.code)) return cause;
  const error = new Error('飞书授权二维码生成失败');
  error.code = 'LARK_QRCODE_GENERATION_FAILED';
  error.cause = cause;
  return error;
}

export function verifyQrcode(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (cause) {
    const error = new Error('飞书授权二维码生成失败');
    error.code = 'LARK_QRCODE_GENERATION_FAILED';
    error.cause = cause;
    throw error;
  }
  if (bytes.length > 1024 * 1024 || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    const error = new Error('飞书授权二维码格式无效');
    error.code = 'LARK_QRCODE_INVALID';
    throw error;
  }
  return bytes;
}
