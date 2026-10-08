import { describe, expect, it } from 'vitest';
import { categoryTypeName, selectCategory, summarizeCategory } from '../src/categories.js';

describe('categories', () => {
  const wallet = [
    { _id: 'local-food', name: 'Food', type: 2, account: 'w1', metadata: 'food0' },
    { _id: 'local-pay', name: 'Salary', type: 1, account: 'w1', metadata: 'salary0' }
  ];
  const global = [
    { _id: 'global-food', name: 'Food', type: 2, account: 'w1', metadata: 'food0' },
    { _id: 'global-pay', name: 'Salary', type: 1, account: 'w1', metadata: 'salary0' }
  ];

  it('labels system categories and keeps the parent and wallet', () => {
    const summary = summarizeCategory({
      _id: 'cat-debt',
      name: 'Debt',
      type: 1,
      metadata: 'IS_DEBT',
      account: 'w1',
      parent: { _id: 'parent-1', name: 'Income' }
    });
    expect(summary.systemLabel).toBe('Debt');
    expect(summary.typeName).toBe('income');
    expect(summary.parentId).toBe('parent-1');
    expect(summary.walletId).toBe('w1');
  });

  it('names type 1 income and type 2 expense', () => {
    expect(categoryTypeName(1)).toBe('income');
    expect(categoryTypeName(2)).toBe('expense');
  });

  it('resolves a wallet category id to the global id', () => {
    const resolved = selectCategory(wallet, global, 'w1', { categoryId: 'local-food' });
    expect(resolved.id).toBe('global-food');
    expect(resolved.source).toBe('resolved');
  });

  it('resolves a name within the requested direction', () => {
    const resolved = selectCategory(wallet, global, 'w1', { categoryName: 'salary', direction: 'income' });
    expect(resolved.id).toBe('global-pay');
  });

  it('refuses a category from another wallet', () => {
    expect(() =>
      selectCategory(wallet, [{ _id: 'other', name: 'Food', account: 'w9', type: 2 }], 'w1', { categoryId: 'other' })
    ).toThrow(/different wallet/);
  });
});
