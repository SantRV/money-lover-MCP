/**
 * Category type values observed in ferdhika31/moneylover-client-go,
 * leMaik/moneylover-cli, and allexxis/moneylover-client:
 *   1 = income, 2 = expense.
 */

export const CategoryType = Object.freeze({
  INCOME: 1,
  EXPENSE: 2
});

export const categoryTypeName = (type) => {
  const value = Number(type);
  if (value === CategoryType.INCOME) {
    return 'income';
  }
  if (value === CategoryType.EXPENSE) {
    return 'expense';
  }
  return 'unknown';
};

export const coerceCategoryType = (type) => {
  if (type == null || type === '') {
    return CategoryType.INCOME;
  }
  const value = Number(type);
  if (value !== CategoryType.INCOME && value !== CategoryType.EXPENSE) {
    throw new Error('category type must be 1 (income) or 2 (expense)');
  }
  return value;
};

export const unwrapList = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  for (const key of ['categories', 'transactions', 'data', 'list', 'items']) {
    if (Array.isArray(payload[key])) {
      return payload[key];
    }
  }
  const values = Object.values(payload);
  if (values.length > 0 && values.every((value) => value && typeof value === 'object' && !Array.isArray(value))) {
    return values;
  }
  const nested = values.find(Array.isArray);
  return Array.isArray(nested) ? nested : [];
};

const metadataKey = (value) => (value == null ? '' : String(value));

/**
 * System categories from the Money Lover web bundle (metadata → English label).
 * `type` on these rows is still 1 (income) or 2 (expense).
 */
export const SYSTEM_CATEGORY_LABELS = Object.freeze({
  IS_OTHER_EXPENSE: 'Other expense',
  IS_OTHER_INCOME: 'Other income',
  IS_DEBT: 'Debt',
  IS_LOAN: 'Loan',
  IS_REPAYMENT: 'Repayment',
  IS_DEBT_COLLECTION: 'Debt collection',
  IS_PAY_INTEREST: 'Pay interest',
  IS_COLLECT_INTEREST: 'Collect interest',
  IS_OUTGOING_TRANSFER: 'Outgoing transfer',
  IS_INCOMING_TRANSFER: 'Incoming transfer',
  IS_UNCATEGORIZED_EXPENSE: 'Uncategorized expense',
  IS_UNCATEGORIZED_INCOME: 'Uncategorized income'
});

export const systemCategoryLabel = (metadata) => SYSTEM_CATEGORY_LABELS[metadataKey(metadata)] ?? null;

export const summarizeCategory = (category) => {
  const parent = category?.parent && typeof category.parent === 'object' ? category.parent : null;
  const type = category?.type == null ? null : Number(category.type);
  const metadata = metadataKey(category?.metadata);
  return {
    id: category?._id ?? null,
    _id: category?._id ?? null,
    name: category?.name ?? '',
    type,
    typeName: categoryTypeName(type),
    icon: category?.icon ?? null,
    metadata,
    systemLabel: systemCategoryLabel(metadata),
    walletId: category?.account ?? category?.walletId ?? null,
    parentId: parent?._id ?? (typeof category?.parent === 'string' ? category.parent : (category?.parentId ?? null)),
    parentName: parent?.name ?? null
  };
};

export const matchGlobalCategory = (globalList, walletId, walletCategory) => {
  const sameWallet = globalList.filter((category) => (category.account ?? category.walletId ?? '') === walletId);
  const name = walletCategory.name ?? '';
  const metadata = metadataKey(walletCategory.metadata);
  const exact = sameWallet.find((category) => category.name === name && metadataKey(category.metadata) === metadata);
  if (exact) {
    return exact;
  }
  const byName = sameWallet.filter((category) => category.name === name);
  if (byName.length === 1) {
    return byName[0];
  }
  return null;
};

const filterByDirection = (categories, direction) => {
  if (!direction || categories.every((category) => category?.type == null)) {
    return categories;
  }
  const expected = direction === 'income' ? CategoryType.INCOME : direction === 'expense' ? CategoryType.EXPENSE : null;
  if (!expected) {
    return categories;
  }
  return categories.filter((category) => Number(category.type) === expected);
};

export const selectCategory = (walletList, globalList, walletId, { categoryId, categoryName, direction } = {}) => {
  const id = typeof categoryId === 'string' ? categoryId.trim() : '';
  const name = typeof categoryName === 'string' ? categoryName.trim() : '';

  if (id) {
    const globalHit = globalList.find((category) => category._id === id);
    if (globalHit) {
      const account = globalHit.account ?? globalHit.walletId ?? '';
      if (account && account !== walletId) {
        throw new Error('Category belongs to a different wallet');
      }
      return { category: globalHit, id: globalHit._id, source: 'global' };
    }

    const walletHit = walletList.find((category) => category._id === id);
    if (walletHit) {
      const mapped = matchGlobalCategory(globalList, walletId, walletHit);
      if (mapped) {
        return { category: mapped, id: mapped._id, source: 'resolved' };
      }
      return { category: walletHit, id: walletHit._id, source: 'wallet' };
    }
    if (!name) {
      return { category: null, id, source: 'passthrough' };
    }
  }

  const label = name || id;
  if (!label) {
    throw new Error('categoryId or category is required');
  }

  const named = walletList.filter(
    (category) => category._id === label || String(category.name ?? '').toLowerCase() === label.toLowerCase()
  );
  const filtered = filterByDirection(named, direction);
  if (filtered.length === 1) {
    const mapped = matchGlobalCategory(globalList, walletId, filtered[0]);
    const chosen = mapped ?? filtered[0];
    return {
      category: chosen,
      id: chosen._id,
      source: mapped ? 'resolved-name' : 'wallet-name'
    };
  }
  if (filtered.length === 0) {
    const hint = direction ? ` (${direction})` : '';
    throw new Error(`No category named "${label}"${hint} in this wallet`);
  }
  const candidates = filtered.map((category) => `${category.name} [${category._id}]`).join(', ');
  throw new Error(
    `Category name "${label}" matches more than one category. Pass categoryId. Candidates: ${candidates}`
  );
};
