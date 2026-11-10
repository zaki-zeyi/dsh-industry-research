import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  return { dir, path, store, service, researcher, publisher, async close() {
    try { await service.close(); }
    finally {
      // Keep only Store's allowlisted diagnostics, never business tables or CLI output.
      if (process.env.CI_ARTIFACT_DIR) {
        try {
          const rows = store.runtimeLogs({ limit: 1000 });
          if (rows.length) {
            mkdirSync(process.env.CI_ARTIFACT_DIR, { recursive: true });
            writeFileSync(join(process.env.CI_ARTIFACT_DIR, `runtime-${randomUUID()}.json`), JSON.stringify(rows, null, 2));
          }
        } catch { console.warn('Unable to export test runtime diagnostics'); }
      }
      store.close(); rmSync(dir, { recursive: true, force: true });
    }
  } };
}
