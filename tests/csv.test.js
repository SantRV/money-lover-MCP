import { describe, expect, it } from 'vitest';
import { detectDateOrder, rowsFromBankCsv } from '../src/csv.js';

describe('bank CSV', () => {
  it('reads an Australian signed amount export', () => {
    const parsed = rowsFromBankCsv(
      'Date,Amount,Description\n18/04/2026,-12.50,"Cafe, Adelaide"\n18/04/2026,2500.00,Salary\n'
    );
    expect(parsed.dateOrder).toBe('DMY');
    expect(parsed.rows[0]).toMatchObject({
      date: '2026-04-18',
      amount: -12.5,
      note: 'Cafe, Adelaide',
      direction: 'expense'
    });
    expect(parsed.rows[1].direction).toBe('income');
  });

  it('reads separate debit and credit columns', () => {
    const parsed = rowsFromBankCsv(
      'Date,Narrative,Debit Amount,Credit Amount\n18/04/2026,Groceries,42.10,\n19/04/2026,Pay,,3000\n',
      { expenseCategory: 'Groceries', incomeCategory: 'Salary' }
    );
    expect(parsed.rows[0]).toMatchObject({ amount: -42.1, category: 'Groceries', direction: 'expense' });
    expect(parsed.rows[1]).toMatchObject({ amount: 3000, category: 'Salary', direction: 'income' });
  });

  it('detects month-first dates when a month would be impossible as a day', () => {
    expect(detectDateOrder(['04/18/2026', '04/19/2026'])).toBe('MDY');
  });
});
