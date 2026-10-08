export const isAuthError = (error) => {
  if (!error) {
    return false;
  }
  const code = error.code;
  if (code === 401 || code === '401') {
    return true;
  }
  const message = String(error.message ?? '').toLowerCase();
  return (
    message.includes('unauth') ||
    message.includes('invalid token') ||
    message.includes('token expired') ||
    message.includes('jwt')
  );
};
