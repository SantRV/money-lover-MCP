import { describe, expect, it } from 'vitest';
import {
  categoryIdForAdd,
  categoryTypeName,
  selectCategory,
  summarizeCategory,
  unusableCategoryReason
} from '../src/categories.js';

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

  it('keeps the wallet category id when another list has the same name', () => {
    const resolved = selectCategory(wallet, global, 'w1', { categoryId: 'local-food' });
    expect(resolved.id).toBe('local-food');
    expect(resolved.source).toBe('wallet');
  });

  it('resolves a name from the add picker for this wallet', () => {
    const resolved = selectCategory(
      [...wallet, { _id: 'w9-pay', name: 'Salary', type: 1, account: 'w9', metadata: 'salary0' }],
      global,
      'w1',
      { categoryName: 'salary', direction: 'income' }
    );
    expect(resolved.id).toBe('global-pay');
    expect(resolved.source).toBe('list-all');
  });

  it('selects the shared add id that belongs to this wallet', () => {
    const shared = 'B012AA1D774D42B6A4C68A84B5977C4C';
    const resolved = selectCategory(
      [],
      [
        { _id: shared, name: 'Bank fees', type: 2, account: 'other-wallet' },
        { _id: shared, name: 'Bank fees', type: 2, account: 'w1' }
      ],
      'w1',
      { categoryId: shared }
    );
    expect(resolved.id).toBe(shared);
    expect(resolved.category.account).toBe('w1');
  });

  it('refuses a stored name that the add picker does not offer', () => {
    expect(() =>
      selectCategory(
        [{ _id: '30BC0A0E515245EBAC29F55BAFDA1780', name: 'Other Expense', type: 2, account: 'w1' }],
        [],
        'w1',
        { categoryName: 'Other Expense' }
      )
    ).toThrow(/CATEGORY_NOT_USABLE|not in the add picker/);
  });

  it('names why a stored category is unusable', () => {
    expect(unusableCategoryReason({ metadata: 'IS_UNCATEGORIZED_EXPENSE', account: 'w1' }, 'w1')).toBe('uncategorized');
    expect(unusableCategoryReason({ isDelete: true, account: 'w1', name: 'Old' }, 'w1')).toBe('deleted');
    expect(unusableCategoryReason({ account: 'w9', name: 'Food' }, 'w1')).toBe('different_wallet');
    expect(
      unusableCategoryReason({ _id: '30BC0A0E515245EBAC29F55BAFDA1780', name: 'Other Expense', account: 'w1' }, 'w1')
    ).toBe('not_in_list_all');
  });

  it('does not use another wallet when the name is missing here', () => {
    expect(() =>
      selectCategory(
        [{ _id: 'w9-food', name: 'Food', type: 2, account: 'w9' }],
        [{ _id: 'w9-add', name: 'Food', type: 2, account: 'w9' }],
        'w1',
        { categoryName: 'Food' }
      )
    ).toThrow(/No category named "Food"/);
  });

  it('asks for a category id when parent and child names collide', () => {
    const tree = [
      { _id: 'g1', name: 'Groceries', type: 2, account: 'w1', parent: { _id: 'p1', name: 'Food' } },
      { _id: 'g2', name: 'Groceries', type: 2, account: 'w1', parent: { _id: 'p2', name: 'Household' } }
    ];
    expect(() => selectCategory([], tree, 'w1', { categoryName: 'Groceries' })).toThrow(
      /Food \/ Groceries \[g1\].*Household \/ Groceries \[g2\]/
    );
  });

  it('does not substitute Other expense when the requested name is missing', () => {
    const list = [{ _id: 'other', name: 'Other expense', type: 2, account: 'w1', metadata: 'IS_OTHER_EXPENSE' }];
    expect(() => selectCategory(list, [], 'w1', { categoryName: 'Coffee' })).toThrow(/No category named "Coffee"/);
  });

  it('maps a stored category id to the list-all id for the same wallet', () => {
    const mapped = categoryIdForAdd(
      {
        id: 'FBD2B817A8DE4AE0B8BF8261006DCEC5',
        category: { _id: 'FBD2B817A8DE4AE0B8BF8261006DCEC5', name: 'Bank fees', type: 2, account: 'w1' }
      },
      [
        { _id: 'B012AA1D774D42B6A4C68A84B5977C4C', name: 'Bank fees', type: 2, account: 'w1' },
        { _id: 'other', name: 'Bank fees', type: 2, account: 'w9' }
      ]
    );
    expect(mapped.id).toBe('B012AA1D774D42B6A4C68A84B5977C4C');
  });

  it('keeps a list-all id that was passed in', () => {
    const mapped = categoryIdForAdd(
      {
        id: 'B012AA1D774D42B6A4C68A84B5977C4C',
        category: { _id: 'B012AA1D774D42B6A4C68A84B5977C4C', name: 'Bank fees', type: 2, account: 'w1' }
      },
      [{ _id: 'B012AA1D774D42B6A4C68A84B5977C4C', name: 'Bank fees', type: 2, account: 'w1' }]
    );
    expect(mapped.id).toBe('B012AA1D774D42B6A4C68A84B5977C4C');
  });

  it('uses the parent name when two list-all rows share a name', () => {
    const mapped = categoryIdForAdd(
      {
        id: 'stored',
        category: {
          _id: 'stored',
          name: 'Groceries',
          type: 2,
          account: 'w1',
          parent: { name: 'Food' }
        }
      },
      [
        { _id: 'add-1', name: 'Groceries', type: 2, account: 'w1', parent: { name: 'Food' } },
        { _id: 'add-2', name: 'Groceries', type: 2, account: 'w1', parent: { name: 'Household' } }
      ]
    );
    expect(mapped.id).toBe('add-1');
  });

  it('asks for an add id when two list-all rows share the name', () => {
    const mapped = categoryIdForAdd(
      {
        id: 'stored',
        category: { _id: 'stored', name: 'Groceries', type: 2, account: 'w1' }
      },
      [
        { _id: 'add-1', name: 'Groceries', type: 2, account: 'w1', parent: { name: 'Food' } },
        { _id: 'add-2', name: 'Groceries', type: 2, account: 'w1', parent: { name: 'Household' } }
      ]
    );
    expect(mapped.ambiguous).toBe(true);
    expect(mapped.candidates.map((category) => category._id)).toEqual(['add-1', 'add-2']);
  });

  it('refuses a category from another wallet', () => {
    expect(() =>
      selectCategory(wallet, [{ _id: 'other', name: 'Food', account: 'w9', type: 2 }], 'w1', { categoryId: 'other' })
    ).toThrow(/different wallet/);
  });
});
