export const assertConfirm = ({ confirm, dryRun, action }) => {
  if (dryRun === true) {
    return;
  }
  if (confirm !== true) {
    throw new Error(
      `Refusing to ${action} without confirm: true. Pass dryRun: true to preview the request without writing.`
    );
  }
};
