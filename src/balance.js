import { parseAmount } from './amounts.js';
import { CategoryType } from './categories.js';

const numeric = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  return null;
};

/**
 * The web app stores `/wallet/balance` as `data.balance[0]`.
 * The archived bundle does not show the fields inside that element, so this
 * accepts a number, a numeric string, or the first amount/balance field.
 */
export const readBalance = (payload) => {
  const direct = numeric(payload);
  if (direct != null) {
    return direct;
  }
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      throw new Error('Wallet balance response did not include an amount');
    }
    return readBalance(payload[0]);
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('Wallet balance response did not include an amount');
  }
  if (payload.balance != null) {
    return readBalance(payload.balance);
  }
  for (const key of ['amount', 'money', 'value', 'balanceAmount']) {
    const found = numeric(payload[key]);
    if (found != null) {
      return found;
    }
  }
  const numbers = Object.values(payload)
    .map(numeric)
    .filter((value) => value != null);
  if (numbers.length === 1) {
    return numbers[0];
  }
  throw new Error('Wallet balance response did not include an amount');
};

export const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

/** Income is positive, expense is negative. Returns null when the category type is missing. */
export const signedTransactionDelta = (transaction) => {
  const type = Number(transaction?.category?.type ?? transaction?.categoryType);
  let amount;
  try {
    amount = Math.abs(parseAmount(transaction?.amount));
  } catch {
    return null;
  }
  if (type === CategoryType.INCOME) {
    return amount;
  }
  if (type === CategoryType.EXPENSE) {
    return -amount;
  }
  return null;
};
