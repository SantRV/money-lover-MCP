const SECRET_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'password',
  'request_token',
  'authorization',
  'client_secret'
]);

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){2}/g;

export const redactString = (value) => String(value).replace(JWT_PATTERN, '[redacted]');

export const redact = (value) => {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = SECRET_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(nested);
    }
    return output;
  }
  return value;
};

export const clip = (value, max = 500) => {
  const text = redactString(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
