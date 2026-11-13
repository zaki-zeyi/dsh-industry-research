import { writeFileSync, renameSync } from 'node:fs';
export const name = 'research-terminal-bridge';
export const inject = ['sessions'];
export function apply(ctx, config) {
  let rootId;
  const write = (path, value) => { const temp = `${path}.tmp`; writeFileSync(temp, JSON.stringify(value)); renameSync(temp, path); };
  ctx.on('session/created', session => { if (rootId) return; rootId = String(session.id); write(config.sessionPath, { sessionId: rootId, at: new Date().toISOString() }); });
  ctx.on('session/event', (session, event) => {
    if (String(session.id) !== rootId) return;
    if (event.type === 'turn/end') write(config.completionPath, { type: 'turn-complete', sessionId: rootId, turnId: String(event.data.turn ?? event.seq), reason: event.data.reason?.kind, errorCode: event.data.reason?.kind === 'error' && /^[A-Z0-9_]{1,64}$/.test(event.data.reason.error?.code ?? '') ? event.data.reason.error.code : undefined, at: new Date().toISOString() });
  });
}
