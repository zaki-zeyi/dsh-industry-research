import { defaultHttpInstance, registerApp } from '@larksuiteoapi/node-sdk';

const RETRY_MARK = Symbol.for('dsh-industry-research.registration-retry');
const retryableCodes = /ECONNABORTED|ECONNREFUSED|ECONNRESET|ENETDOWN|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ERR_NETWORK|socket hang up/i;
const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

export function shouldRetryRegistrationRequest(error, signal) {
  if (signal?.aborted) return false;
  try {
    const url = new URL(error?.config?.url);
    if (!['accounts.feishu.cn', 'accounts.larksuite.com'].includes(url.hostname)) return false;
    if (url.pathname !== '/oauth/v1/app/registration') return false;
  } catch {
    return false;
  }
  const status = Number(error?.response?.status);
  if (retryableStatuses.has(status)) return true;
  return !status && retryableCodes.test(`${error?.code ?? ''}\n${error?.message ?? ''}`);
}

export function installRegistrationRetry(http, {
  maxRetries = 4,
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  shouldRetry = shouldRetryRegistrationRequest,
} = {}) {
  if (http[RETRY_MARK]) return;
  Object.defineProperty(http, RETRY_MARK, { value: true });
  http.interceptors.response.use(undefined, async error => {
    const config = error?.config;
    if (!config || !shouldRetry(error, config.signal)) throw error;
    const attempt = Number(config.registrationRetryAttempt ?? 0);
    if (attempt >= maxRetries) throw error;
    config.registrationRetryAttempt = attempt + 1;
    await delay(500 * (2 ** attempt));
    return http(config);
  });
}

export async function registerFeishuApp(options) {
  installRegistrationRetry(defaultHttpInstance);
  return registerApp(options);
}
