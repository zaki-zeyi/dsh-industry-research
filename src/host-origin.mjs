// The desktop custom protocol may omit Referer on its local HTTP iframe.
// Only local DSH hosts are trusted; an arbitrary embedding website is not.
export function hostOrigin(referrer = '', hint = '') {
  for (const value of [referrer, hint]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.username || url.password) continue;
      if (url.protocol === 'dsh-app:' && url.host === 'app') return 'dsh-app://app';
      if (['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url.origin;
    } catch {}
  }
  return null;
}
