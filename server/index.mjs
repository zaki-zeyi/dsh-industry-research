import { startRuntime } from './runtime.mjs';
const runtime = await startRuntime();
console.log(`Research Studio: ${runtime.url} · ${runtime.service.mode} mode`);
process.on('SIGINT', () => runtime.close());
process.on('SIGTERM', () => runtime.close());
