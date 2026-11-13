import { writeFileSync, renameSync } from 'node:fs';
// Codex's documented notify callback. Persist only lifecycle IDs, never message text.
const [path, payload] = process.argv.slice(2);
try {
  const event = JSON.parse(payload);
  if (path && event.type === 'agent-turn-complete') {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ type: 'turn-complete', sessionId: event['thread-id'], turnId: event['turn-id'], at: new Date().toISOString() }));
    renameSync(temp, path);
  }
} catch { process.exitCode = 1; }
