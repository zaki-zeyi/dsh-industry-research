import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { UpdateSlots } from './update-slots.mjs';
import * as basePayload from './payload.mjs';

export const name = 'dsh-industry-research';
export const inject = basePayload.inject;
export const connectRuntime = basePayload.connectRuntime;
const baseVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function apply(ctx, config = {}) {
  if (typeof ctx.plugin !== 'function') return basePayload.apply(ctx, config);
  const dataDir = resolve(config.dataDir ?? resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'industry-research'));
  const slots = new UpdateSlots(dataDir, baseVersion);
  let current;
  const mounted = slots.boot(async slot => {
    const entry = slots.pathFor(slot);
    const payload = slot.kind === 'base' ? basePayload : await import(pathToFileURL(entry).href);
    let runtime, fiber;
    const activationGate = { approved: false };
    try {
      fiber = await ctx.plugin({
        name: `dsh-industry-research-payload-${slot.version}`,
        inject: payload.inject,
        apply: child => payload.apply(child, { ...config, slotUpdater: slots, activationGate,
          onRuntime: value => { runtime = value; } }),
      });
      if (!runtime?.service) throw new Error('更新槽位未启动工作台服务');
      const response = await fetch(`${runtime.url}/api/health`, { signal: AbortSignal.timeout(5000) });
      const health = await response.json();
      if (!response.ok || health.application !== 'industry-research' || health.version !== slot.version ||
        health.dataIdentity !== (await import('../server/runtime.mjs')).dataIdentity(dataDir)) {
        throw new Error(`更新槽位健康检查失败：${slot.version}`);
      }
      activationGate.approved = true;
      return fiber;
    } catch (error) {
      await Promise.resolve(fiber?.dispose?.()).catch(() => {});
      throw error;
    }
  }).then(fiber => { current = fiber; return fiber; });
  ctx.effect(() => async () => { await mounted.catch(() => {}); await current?.dispose(); });
  return mounted;
}
