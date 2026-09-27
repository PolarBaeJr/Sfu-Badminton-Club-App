// RFC 4180 CSV, as three pure functions with no I/O.
//
// WHY THIS EXISTS RATHER THAN `rows.map((r) => r.join(','))`. That line is
// already in this codebase, in
// apps/admin/src/app/tournaments/[id]/events/[eventId]/components/LeaderboardTab.tsx,
// and it is correct there only because every column it joins is a rank, a seed
// or an elo number. Point the same line at an audit trail and it corrupts the
// file in silence: a reason an officer typed with a comma in it becomes two
// columns, a quotation mark in a provider-supplied name ends the field early,
// and a reason containing a newline ends the ROW. Nothing throws, the file
// opens, and it says something other than what happened. That is the one
// failure an accountability document may not have, so the escaping lives here,
// once, with tests over it.
//
// NO BOM, DELIBERATELY. toCsv emits bytes and only bytes, so its output is
// exact and comparable in a test. The route handler that serves a download
// prepends '﻿' itself. Both halves of that are a decision:
//
//   Without a BOM, Excel on Windows reads the file as the system codepage and
//   mangles every accented name in it. That is silent corruption of the exact
//   thing the document is for, and the reader is the club owner opening the
//   file in Excel or Sheets, so the BOM wins at the download.
//
//   With a BOM baked in here, a naive programmatic parser sees three extra
//   bytes glued to the first header cell and the column it names stops
//   matching. Keeping it out of the pure function leaves a machine consumer
//   clean bytes and leaves this module testable byte for byte.
//
// FORMULA INJECTION IS REACHABLE HERE, which is why the guard below is not
// theoretical hygiene. A cell beginning `=`, `+`, `-`, `@`, a tab or a carriage
// return is evaluated as a formula when the file is opened in Excel, and the
// values this serializer carries are `audit_logs.reason` (free text an officer
// typed) and names supplied by an identity provider. A single leading
// apostrophe makes the cell text, which is predictable and reversible by the
// reader. Faithful and executable is the wrong trade for a file any exec can
// download.

/** Characters that force a field to be quoted. Comma, quote, CR, LF. */
const MUST_QUOTE = /[",\r\n]/;

/** The leading characters Excel reads as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One cell, escaped.
 *
 * Null and undefined become an EMPTY CELL rather than the strings "null" and
 * "undefined". Every source feeding this has nullable columns, and a reader
 * scanning a column of reasons should see a blank where there was no reason,
 * not a word that looks like data.
 *
 * Leading and trailing whitespace forces quoting even though RFC 4180 does not
 * require it. Names arrive from identity providers with trailing spaces on them
 * (the auth log's actor_name is full of them), and an unquoted trailing space
 * is stripped by most parsers, which turns two distinct values into one.
 *
 * THE FORMULA GUARD APPLIES TO STRINGS ONLY. A negative number is not a
 * formula, and prefixing `-5` would corrupt any numeric column a later source
 * adds. Every column this module is used for today is text.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';

  const raw = typeof value === 'string' ? value : String(value);

  // Guarded and then ALWAYS quoted, so the apostrophe sits inside a field whose
  // boundaries a parser cannot mistake. `=cmd` needs no quotes by the rules
  // above, and quoting it anyway costs two bytes and removes a question.
  if (typeof value === 'string' && FORMULA_START.test(raw)) {
    return `"'${raw.replace(/"/g, '""')}"`;
  }

  if (MUST_QUOTE.test(raw) || raw !== raw.trim()) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/** One row of already-escaped cells. */
export function csvRow(fields: readonly unknown[]): string {
  return fields.map(csvField).join(',');
}

/**
 * A whole file: a header row, then the data rows.
 *
 * CRLF between rows and a CRLF after the last one, which is RFC 4180 to the
 * letter. The trailing terminator is what stops a parser that reads line by
 * line from treating the final row differently from every other row.
 */
export function toCsv(
  header: readonly unknown[],
  rows: readonly (readonly unknown[])[],
): string {
  return [csvRow(header), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}
