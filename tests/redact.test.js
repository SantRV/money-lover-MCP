import { describe, expect, it } from 'vitest';
import { redact } from '../src/redact.js';

describe('redact', () => {
  it('removes tokens and passwords from tool payloads', () => {
    const safe = redact({
      access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
      password: 'secret',
      note: 'bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
      tokenDevice: 'web'
    });
    expect(safe.access_token).toBe('[redacted]');
    expect(safe.password).toBe('[redacted]');
    expect(safe.note).not.toContain('eyJ');
    expect(safe.tokenDevice).toBe('web');
  });
});
