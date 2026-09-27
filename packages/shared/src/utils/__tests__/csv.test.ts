import { describe, it, expect } from 'vitest';
import { csvField, csvRow, toCsv } from '../csv';

// WHAT THESE TESTS ARE ACTUALLY DEFENDING. The alternative to this module is
// `rows.map((r) => r.join(','))`, which is live in
// apps/admin/src/app/tournaments/[id]/events/[eventId]/components/LeaderboardTab.tsx
// and is not reusable here. It has no escaping at all: it is correct only over
// ranks, seeds and elo numbers, and the columns this serializer carries are an
// officer's free-text reason and a provider-supplied name. Every assertion
// below is a value that line would have written out wrong without failing.

describe('csvField', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvField('player_banned')).toBe('player_banned');
    expect(csvField('Aiko Tanaka')).toBe('Aiko Tanaka');
  });

  it('quotes a comma, which is the join that loses a column', () => {
    expect(csvField('Banned, then reinstated')).toBe('"Banned, then reinstated"');
  });

  it('doubles an embedded quote rather than ending the field on it', () => {
    expect(csvField('She said "no"')).toBe('"She said ""no"""');
  });

  it('quotes a newline, which is the join that loses a row', () => {
    expect(csvField('first\nsecond')).toBe('"first\nsecond"');
    expect(csvField('first\r\nsecond')).toBe('"first\r\nsecond"');
  });

  it('quotes leading and trailing whitespace, which a parser would otherwise strip', () => {
    // The auth log's actor_name arrives like this from the identity provider.
    expect(csvField('Viraj Veer Chowdhary ')).toBe('"Viraj Veer Chowdhary "');
    expect(csvField('  padded')).toBe('"  padded"');
  });

  it('writes null and undefined as an empty cell, not as a word', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('stringifies a number and leaves it unguarded', () => {
    // A negative number is not a formula. Prefixing it would corrupt any
    // numeric column a later source adds.
    expect(csvField(42)).toBe('42');
    expect(csvField(-5)).toBe('-5');
  });

  it('defuses every character Excel reads as the start of a formula', () => {
    expect(csvField('=1+1')).toBe(`"'=1+1"`);
    expect(csvField('+1')).toBe(`"'+1"`);
    expect(csvField('-1+1')).toBe(`"'-1+1"`);
    expect(csvField('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvField('\tleading tab')).toBe(`"'\tleading tab"`);
    expect(csvField('\rleading cr')).toBe(`"'\rleading cr"`);
  });

  it('still escapes quotes inside a value it has defused', () => {
    expect(csvField('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
  });
});

describe('csvRow', () => {
  it('joins cells with a comma and escapes each one', () => {
    expect(csvRow(['a', 'b,c', null, 3])).toBe('a,"b,c",,3');
  });
});

describe('toCsv', () => {
  it('joins rows with CRLF and terminates the last one', () => {
    expect(toCsv(['x', 'y'], [['1', '2'], ['3', '4']])).toBe('x,y\r\n1,2\r\n3,4\r\n');
  });

  it('emits the header alone when there are no rows', () => {
    expect(toCsv(['x', 'y'], [])).toBe('x,y\r\n');
  });

  it('emits no byte order mark, so the bytes are exactly the fields', () => {
    // The BOM is the route handler's job. See the module header: baking it in
    // here would glue three bytes to the first header cell for every machine
    // consumer, and would make every assertion in this file start with it.
    expect(toCsv(['when'], []).startsWith('﻿')).toBe(false);
  });
});

// A DELIBERATELY MINIMAL RFC 4180 READER, written here rather than imported.
// The point of a round trip is to check the serializer against the standard,
// and a parser sharing code with it would only check it against itself.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { quoted = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r' && text[i + 1] === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; i += 2; continue;
    }
    field += c; i += 1;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

describe('round trip', () => {
  it('reads back every hostile value in one row, unchanged', () => {
    const header = ['occurred_at', 'actor', 'detail', 'ref'];
    const hostile = [
      '2026-09-21 19:04:00',
      'Viraj Veer Chowdhary ',
      'Banned, then "reinstated"\nafter the appeal',
      '4b1c2d3e',
    ];
    const parsed = parseCsv(toCsv(header, [hostile]));
    expect(parsed).toEqual([header, hostile]);
  });

  it('reads a defused formula back with its apostrophe, which is the reversible part', () => {
    // The guard is not lossless and is not meant to be. What matters is that
    // the reader can see exactly what was done and undo it by eye.
    const parsed = parseCsv(toCsv(['detail'], [['=cmd|calc']]));
    expect(parsed).toEqual([['detail'], [`'=cmd|calc`]]);
  });
});
