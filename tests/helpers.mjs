import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { ResearchService } from '../server/service.mjs';
import { DemoResearcher } from '../server/providers/demo.mjs';
import { DemoPublisher } from '../server/providers/publisher.mjs';
export async function until(fn, timeout = 5000) { const start = Date.now(); while (Date.now() - start < timeout) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 15)); } throw new Error('等待状态超时'); }
export function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'research-test-')); const path = join(dir, 'test.sqlite'); const store = new Store(path);
  const researcher = options.researcher ?? new DemoResearcher({ delayMs: 5, failResearch: options.failResearch });
  const publisher = options.publisher ?? new DemoPublisher(store, { failPublish: options.failPublish });
  const service = new ResearchService(store, researcher, publisher);
  return { dir, path, store, service, researcher, publisher, async close() { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
