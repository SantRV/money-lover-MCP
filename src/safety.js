export const CONFIRM_REQUIRED = 'CONFIRM_REQUIRED';

export const assertConfirm = ({ confirm, dryRun, action }) => {
  if (dryRun === true) {
    return;
  }
  if (confirm !== true) {
    const error = new Error(
      `Refusing to ${action} without confirm: true. Pass dryRun: true to preview the request without writing.`
    );
    error.code = CONFIRM_REQUIRED;
    throw error;
  }
};
