import { describe, expect, it } from 'vitest';
import { assertConfirm, CONFIRM_REQUIRED } from '../src/safety.js';

describe('destructive confirms', () => {
  it('requires confirm for a real delete', () => {
    expect(() => assertConfirm({ confirm: false, action: 'delete this transaction' })).toThrow(
      expect.objectContaining({ code: CONFIRM_REQUIRED })
    );
    expect(() => assertConfirm({ action: 'merge these categories' })).toThrow(
      expect.objectContaining({ code: CONFIRM_REQUIRED, message: expect.stringMatching(/confirm: true/) })
    );
  });

  it('allows a dry run without confirm', () => {
    expect(() => assertConfirm({ dryRun: true, action: 'delete this category' })).not.toThrow();
  });

  it('allows the delete when confirm is true', () => {
    expect(() => assertConfirm({ confirm: true, action: 'delete this transaction' })).not.toThrow();
  });
});
