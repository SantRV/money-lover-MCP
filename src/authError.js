/** Expired session. The web client refreshes when the JSON body has `e === 706`. */
export const NOT_AUTHORIZED_CODE = 706;

/** Device missing. The web client treats `e === 717` as a dead session. */
export const DEVICE_NOT_FOUND_CODE = 717;

/** Device blocked. The web client treats `e === 718` as a dead session. */
export const DEVICE_BLOCKED_CODE = 718;

const numericCode = (code) => {
  if (typeof code === 'number' && Number.isFinite(code)) {
    return code;
  }
  if (typeof code === 'string' && code.trim() !== '') {
    const parsed = Number(code);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * First non-zero API error code.
 * The web client reads `e` (706/717/718). Older responses use `error`.
 * A literal 0 in `error` must not hide a non-zero `e`.
 */
export const apiErrorCode = (payload) => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  for (const candidate of [payload.e, payload.error, payload.code]) {
    const code = numericCode(candidate);
    if (code != null && code !== 0) {
      return code;
    }
  }
  return null;
};

export const isDeviceErrorCode = (code) => {
  const numeric = numericCode(code);
  return numeric === DEVICE_NOT_FOUND_CODE || numeric === DEVICE_BLOCKED_CODE;
};

export const deviceErrorMessage = (code) => {
  const numeric = numericCode(code);
  if (numeric === DEVICE_NOT_FOUND_CODE) {
    return 'Money Lover error 717: device not found. This session is tied to a device the account does not have. Log in again from the Money Lover app, then retry. Refreshing the token will not fix this.';
  }
  if (numeric === DEVICE_BLOCKED_CODE) {
    return 'Money Lover error 718: device blocked. Unblock this device in the Money Lover app, then log in again. Refreshing the token will not fix this.';
  }
  return null;
};

export const isDeviceError = (error) => isDeviceErrorCode(error?.code);

export const isAuthError = (error) => {
  if (!error || isDeviceError(error)) {
    return false;
  }
  const code = numericCode(error.code);
  if (code === 401 || code === NOT_AUTHORIZED_CODE) {
    return true;
  }
  const message = String(error.message ?? '').toLowerCase();
  return (
    message.includes('unauth') ||
    message.includes('not authorized') ||
    message.includes('invalid token') ||
    message.includes('token expired') ||
    message.includes('jwt')
  );
};
