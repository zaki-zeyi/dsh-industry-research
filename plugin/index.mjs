import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { UpdateSlots } from './update-slots.mjs';
import { pauseForUpdate } from './update-busy.mjs';
import * as basePayload from './payload.mjs';
import { confirmUpdateRuntime } from './update-operation.mjs';

export const name = 'dsh-industry-research';
export const inject = basePayload.inject;
export const connectRuntime = basePayload.connectRuntime;
const baseVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function apply(ctx, config = {}) {
  if (typeof ctx.plugin !== 'function') return basePayload.apply(ctx, config);
  const dataDir = resolve(config.dataDir ?? resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'industry-research'));
  const slots = new UpdateSlots(dataDir, baseVersion);
  let status = { state: 'starting', version: baseVersion }, port = config.port ?? 0;
  slots.onSwitch = slot => { status = { state: 'switching', version: slot.version }; };
  slots.onFailure = error => { status = { state: 'error', message: error.message }; };
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/industry-research/status', handler(_req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ ...status, bootstrapVersion: baseVersion }));
  } }));
  const mounted = slots.boot(async slot => {
    const entry = slots.pathFor(slot);
    const payload = slot.kind === 'base' ? basePayload : await import(pathToFileURL(entry).href);
    let runtime, fiber;
    const activationGate = { approved: false };
    try {
      fiber = await ctx.plugin({
        name: `dsh-industry-research-payload-${slot.version}`,
        inject: payload.inject,
        apply: child => payload.apply(child, { ...config, port, slotUpdater: slots, activationGate, managedStatus: true,
          onRuntime: value => { runtime = value; } }),
      });
      if (!runtime?.service) throw new Error('更新槽位未启动工作台服务');
      const response = await fetch(`${runtime.url}/api/health`, { signal: AbortSignal.timeout(5000) });
      const health = await response.json();
      if (!response.ok || health.application !== 'industry-research' || health.version !== slot.version ||
        health.dataIdentity !== (await import('../server/runtime.mjs')).dataIdentity(dataDir)) {
        throw new Error(`更新槽位健康检查失败：${slot.version}`);
      }
      port = Number(new URL(runtime.url).port);
      return {
        quiesce: () => pauseForUpdate(runtime.service),
        dispose: async () => { await fiber.dispose(); },
        confirm: async () => {
          activationGate.approved = true;
          await runtime.activate?.();
          confirmUpdateRuntime(resolve(dataDir, 'updates'), slot.version);
          status = { state: 'ready', url: runtime.url, version: slot.version, owned: runtime.owned };
        },
      };
    } catch (error) {
      await Promise.resolve(fiber?.dispose?.()).catch(() => {});
      throw error;
    }
  }).catch(error => { status = { state: 'error', message: error.message }; throw error; });
  ctx.effect(() => async () => { await slots.close(); });
  return mounted;
}
