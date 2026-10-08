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

const accountOf = (category) => category?.account ?? category?.walletId ?? '';

const parentNameOf = (category) => {
  const parent = category?.parent;
  if (parent && typeof parent === 'object' && parent.name) {
    return String(parent.name);
  }
  if (typeof category?.parentName === 'string' && category.parentName) {
    return category.parentName;
  }
  return '';
};

const candidateLabel = (category) => {
  const parent = parentNameOf(category);
  const name = category?.name ?? '';
  const id = category?._id ?? '';
  return parent ? `${parent} / ${name} [${id}]` : `${name} [${id}]`;
};

const belongsToWallet = (category, walletId) => {
  const account = accountOf(category);
  return account === '' || account === walletId;
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

/**
 * Pick a category for one wallet.
 * The wallet's own list is the authority. An id on that list is sent as-is.
 * An id that another wallet owns is rejected. A name is matched only inside this wallet.
 * Nothing falls back to a category named Others or Other expense.
 */
export const selectCategory = (walletList, globalList, walletId, { categoryId, categoryName, direction } = {}) => {
  const id = typeof categoryId === 'string' ? categoryId.trim() : '';
  const name = typeof categoryName === 'string' ? categoryName.trim() : '';
  const walletRows = Array.isArray(walletList) ? walletList : [];
  const globalRows = Array.isArray(globalList) ? globalList : [];

  if (id) {
    const walletHit = walletRows.find((category) => category._id === id);
    if (walletHit) {
      if (!belongsToWallet(walletHit, walletId)) {
        throw new Error('Category belongs to a different wallet');
      }
      return { category: walletHit, id: walletHit._id, source: 'wallet' };
    }

    const globalHit = globalRows.find((category) => category._id === id);
    if (globalHit) {
      if (!belongsToWallet(globalHit, walletId)) {
        throw new Error('Category belongs to a different wallet');
      }
      return { category: globalHit, id: globalHit._id, source: 'global' };
    }
    if (!name) {
      return { category: null, id, source: 'passthrough' };
    }
  }

  const label = name || id;
  if (!label) {
    throw new Error('categoryId or category is required');
  }

  const named = walletRows.filter(
    (category) =>
      belongsToWallet(category, walletId) &&
      (category._id === label || String(category.name ?? '').toLowerCase() === label.toLowerCase())
  );
  const filtered = filterByDirection(named, direction);
  if (filtered.length === 1) {
    return { category: filtered[0], id: filtered[0]._id, source: 'wallet-name' };
  }
  if (filtered.length === 0) {
    const hint = direction ? ` (${direction})` : '';
    throw new Error(`No category named "${label}"${hint} in this wallet`);
  }
  const candidates = filtered.map((category) => candidateLabel(category)).join(', ');
  throw new Error(
    `Category name "${label}" matches more than one category in this wallet. Pass categoryId from list_categories for this wallet. Candidates: ${candidates}`
  );
};

const parentIdOf = (category) => {
  const parent = category?.parent;
  if (parent && typeof parent === 'object' && parent._id) {
    return String(parent._id);
  }
  if (typeof parent === 'string' && parent) {
    return parent;
  }
  if (typeof category?.parentId === 'string' && category.parentId) {
    return category.parentId;
  }
  return '';
};

/**
 * Rows the add dialog can pick: POST /category/list-all, then
 * `account === walletId`. The web app does not treat a blank account as this wallet.
 */
export const listAllCategoriesForWallet = (globalList, walletId) =>
  (Array.isArray(globalList) ? globalList : []).filter((category) => accountOf(category) === walletId);

const sameText = (left, right) => String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();

const narrow = (rows, predicate) => {
  const matched = rows.filter(predicate);
  return matched.length > 0 ? matched : rows;
};

/**
 * Id to send as `category` on POST /transaction/add.
 * The add dialog reads `category/listAllCategory` (POST /category/list-all),
 * keeps rows for this wallet, and posts that row's `_id`. The API stores a
 * different id, which is what POST /category/list and list_categories return.
 * `selected` is a selectCategory result, or `{ id, category }`.
 * Returns `{ id, category }` or `{ ambiguous: true, candidates }`, or null
 * when this wallet has no list-all row to send.
 */
export const categoryIdForAdd = (selected, listAllForWallet) => {
  const walletCategory = selected?.category?._id || selected?.category?.name ? selected.category : null;
  const walletId = accountOf(walletCategory);
  let rows = Array.isArray(listAllForWallet) ? listAllForWallet : [];
  if (walletId) {
    rows = rows.filter((category) => accountOf(category) === walletId);
  }
  const selectedId = selected?.id ?? selected?._id ?? '';
  const direct = rows.find((category) => category?._id === selectedId);
  if (direct) {
    return { id: direct._id, category: direct };
  }

  if (!walletCategory) {
    return null;
  }

  const exactName = rows.filter((category) => String(category?.name ?? '') === String(walletCategory.name ?? ''));
  let candidates =
    exactName.length > 0 ? exactName : rows.filter((category) => sameText(category?.name, walletCategory.name));
  if (candidates.length === 0) {
    return null;
  }
  if (walletCategory.type != null) {
    candidates = narrow(candidates, (category) => Number(category.type) === Number(walletCategory.type));
  }
  const metadata = metadataKey(walletCategory.metadata);
  if (metadata) {
    candidates = narrow(candidates, (category) => metadataKey(category.metadata) === metadata);
  }
  const parentId = parentIdOf(walletCategory);
  const parentName = parentNameOf(walletCategory);
  if (parentId || parentName) {
    candidates = narrow(
      candidates,
      (category) =>
        (parentId && parentIdOf(category) === parentId) || (parentName && sameText(parentNameOf(category), parentName))
    );
  }
  if (candidates.length === 1) {
    return { id: candidates[0]._id, category: candidates[0] };
  }
  return { ambiguous: true, candidates };
};
