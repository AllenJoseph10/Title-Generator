import { describe, expect, it } from 'vitest';
import { csvField, csvRow } from './csv';

describe('csvField', () => {
  it('leaves simple values unquoted', () => {
    expect(csvField('hello')).toBe('hello');
    expect(csvField(42)).toBe('42');
  });

  it('renders null and undefined as empty', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('quotes values containing a comma', () => {
    expect(csvField('a, b')).toBe('"a, b"');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes values containing newlines', () => {
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('csvRow', () => {
  it('joins fields with commas', () => {
    expect(csvRow(['a', 1, null, 'x, y'])).toBe('a,1,,"x, y"');
  });
});
