export const cloudflareWriteMessage = () =>
  'Money Lover blocked this request with a Cloudflare challenge. A browser session on this account added and deleted a transaction on 8 October 2026. Whether a headless client can write without the browser cf_clearance cookie is still unverified. This server does not send a browser cookie. Open web.moneylover.me in a browser if the challenge persists.';

export const readOnlyWriteMessage = () =>
  'Money Lover returned a read-only response for this write. On 8 October 2026 a browser session on this account added and deleted a transaction with no read-only notice, so that response is not the normal state of the website. A headless client can still be refused. This server does not bypass the response.';

export const userCategoryV2Message = () =>
  'This account is tagged user_category_v2. The Money Lover web app disables category and budget add, edit, delete, and merge for that tag. Transaction writes are not disabled by this tag.';

export const looksLikeCloudflare = (status, body) => {
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
