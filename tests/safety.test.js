import { describe, expect, it } from 'vitest';
import { assertConfirm } from '../src/safety.js';

describe('destructive confirms', () => {
  it('requires confirm for a real delete', () => {
    expect(() => assertConfirm({ confirm: false, action: 'delete this transaction' })).toThrow(/confirm: true/);
    expect(() => assertConfirm({ action: 'delete this wallet' })).toThrow(/confirm: true/);
  });

  it('allows a dry run without confirm', () => {
    expect(() => assertConfirm({ dryRun: true, action: 'delete this category' })).not.toThrow();
  });

  it('allows the delete when confirm is true', () => {
    expect(() => assertConfirm({ confirm: true, action: 'delete this transaction' })).not.toThrow();
  });
});
