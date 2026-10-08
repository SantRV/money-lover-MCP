import { describe, expect, it } from 'vitest';
import { amountCents, parseAmount, prepareAmount } from '../src/amounts.js';

describe('amounts', () => {
  it('parses bank formats', () => {
    expect(parseAmount('1,234.50')).toBe(1234.5);
    expect(parseAmount('$12.00')).toBe(12);
    expect(parseAmount('(12.50)')).toBe(-12.5);
    expect(parseAmount('12.50-')).toBe(-12.5);
    expect(parseAmount('-8')).toBe(-8);
  });

  it('stores an expense as a positive magnitude', () => {
    const prepared = prepareAmount('-12.50', 2);
    expect(prepared.amount).toBe('12.50');
    expect(prepared.direction).toBe('expense');
    expect(amountCents(prepared.amount)).toBe(1250);
  });

  it('keeps a whole number free of a decimal suffix', () => {
    expect(prepareAmount('5000', 2).amount).toBe('5000');
  });

  it('rejects a negative amount on an income category', () => {
    expect(() => prepareAmount('-20', 1)).toThrow(/income/);
  });

  it('rejects a positive expense in signed mode', () => {
    expect(() => prepareAmount('20', 2, { amountMode: 'signed' })).toThrow(/negative/);
  });
});
