import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { normalizeApiKey } from './api-key.mjs';
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export class AISettings {
  constructor(directory, { dshAvailable = () => existsSync(resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'profiles/tui/package.json')) } = {}) {
    this.directory = directory; mkdirSync(directory, { recursive: true }); this.dshAvailable = dshAvailable;
    this.path = resolve(directory, 'ai-settings.private.json'); const keyPath = resolve(directory, '.ai-settings.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyPath);
    this.data = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { current: null, revisions: {} };
    // Upgrade only the selection for future tasks; historical revisions stay intact.
    const current = this.data.revisions[this.data.current];
    if (current && current.configuration !== 'native') { const id = randomUUID(); this.data.revisions[id] = { id, agent: current.agent, configuration: 'native' }; this.data.current = id; this.persist(); }
  }
  get() { const current = this.data.revisions[this.data.current] ?? { agent: 'codex', configuration: 'native', baseUrl: DEFAULT_BASE_URL }; return { agent: current.agent, configuration: current.configuration ?? 'custom', baseUrl: current.baseUrl, apiKeyConfigured: Boolean(current.secret), apiKeyValid: this.validSecret(current.secret), dshAvailable: this.dshAvailable() }; }
  validSecret(secret) { if (!secret) return true; try { normalizeApiKey(this.decrypt(secret)); return true; } catch { return false; } }
  save(input) {
    if (!['codex', 'dsh'].includes(input.agent)) throw new Error('请选择 Codex 或 dsh tui');
    if (input.apiKey === undefined && input.baseUrl === undefined && input.clearApiKey === undefined) {
      if (input.agent === 'dsh' && !this.dshAvailable()) throw new Error('尚未安装 dsh tui，请先安装匹配当前 dsh 版本的 TUI 插件');
      const id = randomUUID(); this.data.revisions[id] = { id, agent: input.agent, configuration: 'native' }; this.data.current = id; this.persist(); return this.get();
    }
    // Read compatibility for prior custom configuration versions. Public settings only select an agent.
    let url; try { url = new URL(input.baseUrl ?? DEFAULT_BASE_URL); } catch { throw new Error('Base URL 格式无效'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 必须为不含凭据、查询参数和片段的 HTTP(S) 地址');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('远程 API 地址请使用 HTTPS');
    const baseUrl = url.href.replace(/\/$/, '');
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n\0]/.test(input.apiKey))) throw new Error('API Key 格式无效');
    const old = Object.values(this.data.revisions).findLast(item => item.agent === input.agent);
    const secret = input.clearApiKey ? undefined : input.apiKey?.trim() ? this.encrypt(normalizeApiKey(input.apiKey)) : old?.secret;
    if (secret) normalizeApiKey(this.decrypt(secret));
    if (input.agent === 'dsh' && !this.dshAvailable()) throw new Error('尚未安装 dsh tui，请先安装匹配当前 dsh 版本的 TUI 插件');
    if (input.agent === 'dsh' && !secret) throw new Error('使用 dsh tui 前请填写 API Key');
    if (input.agent === 'codex' && secret && /(^|\.)api\.deepseek\.com$/.test(url.hostname)) throw new Error('DeepSeek 官方接口请选择 dsh tui；Codex 自定义接口需要兼容 Responses API');
    const id = randomUUID(); this.data.revisions[id] = { id, agent: input.agent, baseUrl, ...(secret ? { secret } : {}) }; this.data.current = id;
    this.persist(); return this.get();
  }
  persist() { writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data), { mode: 0o600 }); renameSync(`${this.path}.tmp`, this.path); }
  snapshot() { return this.data.revisions[this.data.current] ? { configId: this.data.current, agent: this.get().agent, configuration: this.get().configuration, ...(this.get().configuration === 'native' ? {} : { baseUrl: this.get().baseUrl }) } : { agent: 'codex', baseUrl: DEFAULT_BASE_URL }; }
  resolve(id) { const config = this.data.revisions[id]; return config ? { ...config, apiKey: config.secret ? normalizeApiKey(this.decrypt(config.secret)) : undefined, secret: undefined } : { agent: 'codex', baseUrl: DEFAULT_BASE_URL }; }
  encrypt(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return { iv: iv.toString('base64'), value: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') }; }
  decrypt(value) { const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64')); cipher.setAuthTag(Buffer.from(value.tag, 'base64')); return Buffer.concat([cipher.update(Buffer.from(value.value, 'base64')), cipher.final()]).toString('utf8'); }
}
