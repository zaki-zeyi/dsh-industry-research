import { randomUUID } from 'node:crypto';

// Port of merge02-04@4811d52: a unique App ID must update its named profile.
// Credentials always go through stdin; never change the CLI default selection.
export async function saveFeishuProfile(binding, appId, secret) {
  const selected = binding.applicationSnapshot();
  const validName = name => typeof name === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(name);
  const existingSelected = selected?.appId === appId && validName(selected.profile);
  let profile = existingSelected ? selected.profile : `research-${randomUUID()}`;
  const write = command => binding.run([...command, '--name', profile, '--app-id', appId, '--app-secret-stdin', '--brand', 'feishu'], { input: secret + '\n' });
  if (existingSelected) {
    await write(['config', 'init']);
    return profile;
  }
  try { await write(['profile', 'add']); }
  catch (error) {
    const text = [error?.message, error?.stdout, error?.stderr, error?.cause?.message].filter(Boolean).join('\n');
    if (!/already used by profile|unique app-id|already exists/i.test(text)) throw error;
    const raw = await binding.run(['profile', 'list']);
    const profiles = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const existing = Array.isArray(profiles) ? profiles.find(p => p?.appId === appId && validName(p.name)) : null;
    if (!existing) throw error;
    profile = existing.name;
    await write(['config', 'init']);
  }
  return profile;
}
