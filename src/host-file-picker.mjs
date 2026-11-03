import { hostOrigin } from './host-origin.mjs';
export function isHostFilePath(path) {
  return typeof path === 'string' && path.length <= 4000 && !/[\x00-\x1f]/.test(path) && /^(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/)/.test(path) && !/^[A-Za-z]:[\\/]fakepath[\\/]/i.test(path);
}
export function pickHostFile({ signal } = {}) {
  const origin = hostOrigin(document.referrer, new URLSearchParams(location.search).get('hostOrigin'));
  if (!origin || window.parent === window) return Promise.reject(new Error('请在 DSH 桌面版选择本地文件；网页版可使用网络链接。'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => { window.removeEventListener('message', receive); signal?.removeEventListener('abort', abort); clearTimeout(timer); };
    const abort = () => { cleanup(); window.parent.postMessage({type:'industry-research:cancel-file-picker',requestId}, origin); reject(new Error('已取消文件选择')); };
    const receive = event => {
      if (event.origin !== origin || event.source !== window.parent || event.data?.type !== 'industry-research:file-result' || event.data.requestId !== requestId) return;
      const value = event.data; cleanup();
      if (value.cancelled) return resolve(null);
      if (value.error) return reject(new Error(value.error));
      if (!isHostFilePath(value.path)) return reject(new Error('宿主未返回有效的本地完整路径，请重新选择文件'));
      if (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > 100 * 1024 * 1024) return reject(new Error('请选择不超过 100 MB 的非空文件'));
      resolve({path:value.path,size:value.size});
    };
    const timer = setTimeout(() => { abort(); }, 5 * 60 * 1000);
    window.addEventListener('message', receive); signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) return abort();
    window.parent.postMessage({type:'industry-research:pick-file',requestId}, origin);
  });
}
