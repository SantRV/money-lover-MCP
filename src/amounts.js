/**
 * Money Lover stores a positive amount. Income versus expense is the category
 * type (1 income, 2 expense), matching ferdhika31/moneylover-client-go and
 * leMaik/moneylover-cli. Bank exports often use a leading minus for debits, so
 * callers may pass a signed value and we send the magnitude.
 */

export const parseAmount = (value) => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('amount is not a finite number');
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new Error('amount is required');
  }

  let text = value.trim();
  if (!text) {
    throw new Error('amount is required');
  }

  let negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  text = text.replace(/[$€£\s]/g, '').replace(/aud|usd|eur|gbp/gi, '');
  if (text.startsWith('+')) {
    text = text.slice(1);
  }
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  }
  if (text.endsWith('-')) {
    negative = !negative;
    text = text.slice(0, -1);
  }

  if (text.includes(',') && text.includes('.')) {
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
      text = text.replaceAll('.', '').replace(',', '.');
    } else {
      text = text.replaceAll(',', '');
    }
  } else if (text.includes(',')) {
    const parts = text.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      text = `${parts[0].replaceAll('.', '')}.${parts[1]}`;
    } else {
      text = text.replaceAll(',', '');
    }
  }

  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error('amount is not a number');
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new Error('amount is not a finite number');
  }
  return negative ? -parsed : parsed;
};

export const amountCents = (value) => {
  const parsed = typeof value === 'number' ? value : parseAmount(value);
  return Math.round(Math.abs(parsed) * 100);
};

export const formatAmount = (value) => {
  const negative = value < 0;
  const cents = Math.round((Math.abs(value) + Number.EPSILON) * 100);
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  const body = fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, '0')}`;
  return negative ? `-${body}` : body;
};

/**
 * JSON number for /transaction/add. The web app's InputMoney emits
 * numeralFormatter().numberConvert, which is parseFloat, not a string.
 */
export const wireAmount = (formatted) => {
  const value = typeof formatted === 'number' ? formatted : Number(formatted);
  if (!Number.isFinite(value)) {
    throw new Error('amount is not a finite number');
  }
  return value;
};

/**
 * @param {unknown} raw
 * @param {number | null | undefined} categoryType 1 income, 2 expense
 * @param {{ amountMode?: 'magnitude' | 'signed' }} [options]
 */
export const prepareAmount = (raw, categoryType, options = {}) => {
  const amountMode = options.amountMode === 'signed' ? 'signed' : 'magnitude';
  const parsed = typeof raw === 'number' && Number.isFinite(raw) ? raw : parseAmount(raw);
  if (parsed === 0) {
    throw new Error('amount must be non-zero');
  }

  const type = Number(categoryType);
  const direction = type === 1 ? 'income' : type === 2 ? 'expense' : 'unknown';
  const negative = parsed < 0;
  const warnings = [];

  if (direction === 'income' && negative) {
    throw new Error(
      'Refusing a negative amount on an income category. Money Lover stores a positive magnitude and uses the category type for direction, so this would be recorded as income.'
    );
  }

  if (amountMode === 'signed') {
    if (direction === 'expense' && !negative) {
      throw new Error(
        'Signed mode expects a negative amount for an expense category. Pass a negative debit, or use amountMode "magnitude" with a positive amount.'
      );
    }
    if (direction === 'income' && negative) {
      throw new Error('Signed mode expects a positive amount for an income category.');
    }
    if (direction === 'unknown') {
      warnings.push('Category type is unknown, so the amount sign was not checked against income or expense.');
    }
  }

  return {
    amount: formatAmount(Math.abs(parsed)),
    inputAmount: formatAmount(parsed),
    direction,
    negative,
    warnings
  };
};
