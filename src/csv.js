import { parseAmount } from './amounts.js';
import { calendarDate } from './dates.js';

const HEADER_ALIASES = {
  date: ['date', 'transaction date', 'posted date', 'processed date', 'value date', 'trans date'],
  amount: ['amount', 'value', 'transaction amount'],
  debit: ['debit', 'debit amount', 'withdrawal', 'money out', 'out'],
  credit: ['credit', 'credit amount', 'deposit', 'money in', 'in'],
  note: [
    'description',
    'narrative',
    'note',
    'details',
    'transaction details',
    'payee',
    'memo',
    'particulars',
    'transaction'
  ],
  category: ['category', 'category name']
};

const detectDelimiter = (headerLine) => {
  const commas = (headerLine.match(/,/g) ?? []).length;
  const semis = (headerLine.match(/;/g) ?? []).length;
  const tabs = (headerLine.match(/\t/g) ?? []).length;
  if (tabs > commas && tabs > semis) {
    return '\t';
  }
  if (semis > commas) {
    return ';';
  }
  return ',';
};

export const parseCsv = (text, delimiter = ',') => {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((value) => String(value).trim() !== ''));
};

const normalHeader = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const findColumn = (headers, field, mapping) => {
  if (mapping?.[field]) {
    const wanted = normalHeader(mapping[field]);
    const index = headers.findIndex((header) => header === wanted);
    if (index >= 0) {
      return index;
    }
  }
  const aliases = HEADER_ALIASES[field] ?? [];
  return headers.findIndex((header) => aliases.includes(header));
};

const cell = (row, index) => (index >= 0 ? String(row[index] ?? '').trim() : '');

const optionalAmount = (raw) => {
  if (!raw) {
    return null;
  }
  const parsed = parseAmount(raw);
  return parsed === 0 ? null : parsed;
};

export const detectDateOrder = (samples) => {
  let sawDmy = false;
  let sawMdy = false;
  let sawYmd = false;
  for (const sample of samples) {
    const text = String(sample ?? '').trim();
    if (/^\d{4}[-/]/.test(text)) {
      sawYmd = true;
      continue;
    }
    const match = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
    if (!match) {
      continue;
    }
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (first > 12 && second <= 12) {
      sawDmy = true;
    } else if (second > 12 && first <= 12) {
      sawMdy = true;
    }
  }
  if (sawDmy && !sawMdy) {
    return 'DMY';
  }
  if (sawMdy && !sawDmy) {
    return 'MDY';
  }
  if (sawYmd && !sawDmy && !sawMdy) {
    return 'YMD';
  }
  return 'DMY';
};

/**
 * Turn a bank CSV into import rows. Does not contact Money Lover.
 * Debit columns become negative amounts (expenses). Credit columns become positive (income).
 */
export const rowsFromBankCsv = (csvText, options = {}) => {
  if (typeof csvText !== 'string' || csvText.trim() === '') {
    throw new Error('csv is required');
  }
  if (csvText.length > 1_000_000) {
    throw new Error('csv is larger than 1MB. Split the statement and import it in parts.');
  }

  const firstLine = csvText.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = options.delimiter ?? detectDelimiter(firstLine);
  const table = parseCsv(csvText, delimiter);
  if (table.length < 2) {
    throw new Error('csv must include a header row and at least one transaction');
  }

  const headers = table[0].map(normalHeader);
  const mapping = options.mapping ?? {};
  const columns = {
    date: findColumn(headers, 'date', mapping),
    amount: findColumn(headers, 'amount', mapping),
    debit: findColumn(headers, 'debit', mapping),
    credit: findColumn(headers, 'credit', mapping),
    note: findColumn(headers, 'note', mapping),
    category: findColumn(headers, 'category', mapping)
  };

  if (columns.date < 0) {
    throw new Error('csv is missing a date column. Pass mapping.date if the header is unusual.');
  }
  if (columns.amount < 0 && columns.debit < 0 && columns.credit < 0) {
    throw new Error('csv is missing an amount, debit, or credit column.');
  }

  const body = table.slice(1);
  const dateSamples = body.map((row) => cell(row, columns.date)).filter(Boolean);
  const dateOrder =
    !options.dateOrder || options.dateOrder === 'auto' ? detectDateOrder(dateSamples) : options.dateOrder;

  const rows = body.map((row, index) => {
    const rawDate = cell(row, columns.date);
    const rawNote = cell(row, columns.note);
    const rawCategory = cell(row, columns.category);
    let amount = null;
    let direction = null;
    let error = null;

    try {
      const debit = columns.debit >= 0 ? optionalAmount(cell(row, columns.debit)) : null;
      const credit = columns.credit >= 0 ? optionalAmount(cell(row, columns.credit)) : null;
      if (debit != null && credit != null) {
        throw new Error('row has both a debit and a credit');
      }
      if (debit != null) {
        amount = -Math.abs(debit);
        direction = 'expense';
      } else if (credit != null) {
        amount = Math.abs(credit);
        direction = 'income';
      } else if (columns.amount >= 0 && cell(row, columns.amount)) {
        amount = parseAmount(cell(row, columns.amount));
        direction = amount < 0 ? 'expense' : 'income';
      } else {
        throw new Error('row has no amount');
      }
    } catch (cause) {
      error = cause.message;
    }

    let date = null;
    if (!error && rawDate) {
      try {
        date = calendarDate(rawDate, { timeZone: options.timeZone, dateOrder });
      } catch (cause) {
        error = cause.message;
      }
    } else if (!rawDate) {
      error = error ?? 'date is required';
    }

    let category = rawCategory || null;
    if (!category && direction === 'expense' && options.expenseCategory) {
      category = options.expenseCategory;
    } else if (!category && direction === 'income' && options.incomeCategory) {
      category = options.incomeCategory;
    } else if (!category && options.defaultCategory) {
      category = options.defaultCategory;
    }

    return {
      index,
      date,
      amount,
      note: rawNote,
      category,
      direction,
      error
    };
  });

  return { delimiter, dateOrder, rows };
};
