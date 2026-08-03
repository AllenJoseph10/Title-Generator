import { describe, expect, it } from 'vitest';
import { parseRecheckValue, InvalidArgError } from './cli-args';

describe('parseRecheckValue', () => {
  it('accepts a positive integer', () => {
    expect(parseRecheckValue('20')).toBe(20);
  });

  it('rejects a missing value (bare --recheck with nothing after it)', () => {
    expect(() => parseRecheckValue(undefined)).toThrow(InvalidArgError);
  });

  it('rejects a non-numeric value', () => {
    expect(() => parseRecheckValue('abc')).toThrow(InvalidArgError);
  });

  it('rejects zero — the exact case that used to silently fall through to mutating mode', () => {
    expect(() => parseRecheckValue('0')).toThrow(InvalidArgError);
  });

  it('rejects a negative value', () => {
    expect(() => parseRecheckValue('-5')).toThrow(InvalidArgError);
  });

  it('rejects a non-integer value', () => {
    expect(() => parseRecheckValue('3.5')).toThrow(InvalidArgError);
  });

  it('rejects trailing garbage that parseInt would have silently accepted', () => {
    // parseInt('20abc', 10) === 20 — this is the bug in the original code.
    expect(() => parseRecheckValue('20abc')).toThrow(InvalidArgError);
  });

  it('error message names what was received', () => {
    expect(() => parseRecheckValue('abc')).toThrow(/"abc"/);
    expect(() => parseRecheckValue(undefined)).toThrow(/<missing>/);
  });
});
