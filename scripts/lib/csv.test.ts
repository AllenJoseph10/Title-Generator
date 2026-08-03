import { describe, expect, it } from 'vitest';
import { csvField, csvRow, parseCsv, parseCsvRows } from './csv';

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

describe('parseCsvRows', () => {
  it('splits plain rows', () => {
    expect(parseCsvRows('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps commas inside quoted fields', () => {
    expect(parseCsvRows('a,"x, y",c')).toEqual([['a', 'x, y', 'c']]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsvRows('"say ""hi"""')).toEqual([['say "hi"']]);
  });

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsvRows('a,"line1\nline2",c')).toEqual([['a', 'line1\nline2', 'c']]);
  });

  it('treats CRLF as one record separator', () => {
    expect(parseCsvRows('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('strips a UTF-8 BOM from the first header name', () => {
    expect(parseCsvRows('﻿video_id,title\n1,x\n')[0]).toEqual(['video_id', 'title']);
  });

  it('does not emit a phantom row for a trailing newline', () => {
    expect(parseCsvRows('a,b\n1,2\n')).toHaveLength(2);
  });

  it('keeps the last row when there is no trailing newline', () => {
    expect(parseCsvRows('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('preserves empty leading and trailing fields', () => {
    expect(parseCsvRows(',a,')).toEqual([['', 'a', '']]);
  });

  it('reads an empty quoted field as an empty string', () => {
    expect(parseCsvRows('a,"",c')).toEqual([['a', '', 'c']]);
  });
});

describe('parseCsv', () => {
  it('keys each row by the header', () => {
    expect(parseCsv('id,title\n7,Hello\n')).toEqual([{ id: '7', title: 'Hello' }]);
  });

  it('throws rather than pad a short row', () => {
    // A short row means the file is corrupt. Padding would slide a caption
    // fragment into a numeric column and be found much later, if ever.
    expect(() => parseCsv('a,b,c\n1,2\n')).toThrow(/line 2 has 2 fields, expected 3/);
  });

  it('skips stray blank lines', () => {
    expect(parseCsv('a,b\n1,2\n\n3,4\n')).toHaveLength(2);
  });

  it('round-trips values written by csvRow', () => {
    const description = 'A man, in a "camel" coat\nwalks past a shopfront';
    const text = [csvRow(['id', 'visual_description']), csvRow([1, description])].join('\n');
    expect(parseCsv(text)[0].visual_description).toBe(description);
  });
});
