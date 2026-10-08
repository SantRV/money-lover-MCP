const CLOUDFLARE_ORIGIN_MIN = 520;
const CLOUDFLARE_ORIGIN_MAX = 527;

export const isCloudflareOriginStatus = (status) => {
  const code = Number(status);
  return Number.isInteger(code) && code >= CLOUDFLARE_ORIGIN_MIN && code <= CLOUDFLARE_ORIGIN_MAX;
};

export const cloudflareWriteMessage = (status) => {
  if (isCloudflareOriginStatus(status)) {
    return `Money Lover’s origin did not finish this request (HTTP ${status}). Cloudflare uses 520–527 when the origin errors or times out. HTTP 524 means the origin stayed silent until Cloudflare gave up. That is not a slow success, and this server does not retry it. Reads on this account answer in a few seconds. A browser session could still add a transaction on 8 October 2026; a headless add can still be refused.`;
  }
  return 'Money Lover blocked this request with a Cloudflare challenge. A browser session on this account added and deleted a transaction on 8 October 2026. Whether a headless client can write without the browser cf_clearance cookie is still unverified. This server does not send a browser cookie. Open web.moneylover.me in a browser if the challenge persists.';
};

export const writeTimeoutMessage = (path, timeoutMs) =>
  `POST ${path} did not answer within ${timeoutMs}ms. Waiting longer usually ends as HTTP 524, a Cloudflare origin timeout, not a saved transaction. This server does not retry the write.`;

export const readOnlyWriteMessage = () =>
  'Money Lover returned a read-only response for this write. On 8 October 2026 a browser session on this account added and deleted a transaction with no read-only notice, so that response is not the normal state of the website. A headless client can still be refused. This server does not bypass the response.';

export const userCategoryV2Message = () =>
  'This account is tagged user_category_v2. The Money Lover web app disables category and budget add, edit, delete, and merge for that tag. Transaction writes are not disabled by this tag.';

export const looksLikeCloudflare = (status, body) => {
  if (isCloudflareOriginStatus(status)) {
    return true;
  }
  const text = String(body ?? '').toLowerCase();
  if (
    text.includes('just a moment') ||
    text.includes('cf-mitigated') ||
    text.includes('challenges.cloudflare.com') ||
    text.includes('cf-ray')
  ) {
    return true;
  }
  return status === 403 && (text.includes('cloudflare') || text.includes('<html'));
};

export const looksLikeReadOnly = (message) => /read[\s-]?only/i.test(String(message ?? ''));
