export const cloudflareWriteMessage = () =>
  'Money Lover blocked this request with a Cloudflare challenge. Writes from a non-browser client often need the browser cf_clearance cookie and a matching User-Agent. This server does not send a browser cookie. Open web.moneylover.me in a browser if the challenge persists.';

export const readOnlyWriteMessage = () =>
  'Money Lover is refusing this write because the website is in read-only mode. Their support site has said since August 2024 that the website is read-only for adding transactions. Check the transaction in the mobile app; this server cannot bypass that restriction.';

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
