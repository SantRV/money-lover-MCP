import { describe, expect, it } from 'vitest';
import { findDuplicate, notesSimilar } from '../src/duplicates.js';

describe('duplicate detection', () => {
  const existing = [{ id: 'txn-1', date: '2026-04-18', cents: 1250, note: 'Cafe Royal Adelaide' }];

  it('matches the same wallet date, amount, and a similar note', () => {
    const match = findDuplicate({ date: '2026-04-18', cents: 1250, note: 'cafe royal adelaide' }, existing);
    expect(match?.id).toBe('txn-1');
  });

  it('matches when the note contains the other note', () => {
    expect(notesSimilar('Cafe Royal', 'Cafe Royal Adelaide')).toBe(true);
  });

  it('does not match a different amount', () => {
    expect(findDuplicate({ date: '2026-04-18', cents: 1300, note: 'Cafe Royal Adelaide' }, existing)).toBeNull();
  });

  it('treats two blank notes on the same day and amount as duplicates', () => {
    const match = findDuplicate({ date: '2026-04-18', cents: 500, note: '' }, [
      { id: 'blank', date: '2026-04-18', cents: 500, note: '   ' }
    ]);
    expect(match?.id).toBe('blank');
  });
});
