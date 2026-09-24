import { describe, it, expect } from 'vitest';
import { classifyError } from '../error-classify';
import type { ErrorCode } from '../error-codes';

const cases: [string, unknown, ErrorCode][] = [
  ['42703 missing column', { code: '42703', message: 'column x does not exist' }, 'DB-101'],
  ['PGRST204 missing column', { code: 'PGRST204', message: 'Could not find the column' }, 'DB-101'],
  ['42P01 missing table', { code: '42P01' }, 'DB-102'],
  ['42883 missing function', { code: '42883' }, 'DB-102'],
  ['PGRST202 missing function', { code: 'PGRST202' }, 'DB-102'],
  ['PGRST205 missing table', { code: 'PGRST205' }, 'DB-102'],
  ['PGRST200 missing relationship', { code: 'PGRST200' }, 'DB-103'],
  ['42501 permission denied', { code: '42501', message: 'permission denied for table x' }, 'DB-201'],
  ['23505 duplicate', { code: '23505' }, 'DB-301'],
  ['23503 foreign key', { code: '23503' }, 'DB-302'],
  ['23514 check', { code: '23514' }, 'DB-303'],
  ['23502 not null', { code: '23502' }, 'DB-303'],
  ['22P02 malformed', { code: '22P02' }, 'DB-304'],
  ['PGRST116 no row', { code: 'PGRST116' }, 'DB-401'],
  ['unwrap Not found', new Error('Not found'), 'DB-401'],
  ['57014 timeout', { code: '57014' }, 'DB-501'],
  ['40001 serialization', { code: '40001' }, 'DB-502'],
  ['40P01 deadlock', { code: '40P01' }, 'DB-502'],
  ['55P03 lock', { code: '55P03' }, 'DB-502'],
  ['53300 too many connections', { code: '53300' }, 'DB-503'],
  ['57P01 admin shutdown', { code: '57P01' }, 'DB-503'],
  ['class 08 connection', { code: '08006' }, 'DB-503'],
  ['P0001 raise', { code: 'P0001', message: 'Tournament is closed' }, 'DB-601'],
  ['fetch failed', new TypeError('fetch failed'), 'NET-001'],
  ['ECONNREFUSED code', { code: 'ECONNREFUSED' }, 'NET-001'],
  ['ENOTFOUND in message', new Error('getaddrinfo ENOTFOUND db'), 'NET-001'],
  ['503 upstream', { status: 503, message: 'Service Unavailable' }, 'NET-002'],
  ['empty body', { message: '{}' }, 'NET-002'],
  ['a code already from the registry', { code: 'AUTH-101' }, 'AUTH-101'],
];

describe('classifyError', () => {
  it.each(cases)('%s', (_label, err, expected) => {
    expect(classifyError(err, 'FEE-101')).toBe(expected);
  });

  it('looks one level into cause', () => {
    expect(classifyError(new Error('wrapped', { cause: { code: '42703' } }), 'FEE-101')).toBe('DB-101');
  });

  it('falls back for anything it does not recognise', () => {
    expect(classifyError(new Error('something else'), 'FEE-101')).toBe('FEE-101');
    expect(classifyError({ code: 'XX000' }, 'DB-000')).toBe('DB-000');
    expect(classifyError(null, 'GEN-000')).toBe('GEN-000');
    expect(classifyError('a string', 'GEN-000')).toBe('GEN-000');
  });

  it('leaves the PostgREST codes it cannot vouch for to the fallback', () => {
    for (const code of ['PGRST000', 'PGRST001', 'PGRST002', 'PGRST301', 'PGRST302']) {
      expect(classifyError({ code }, 'FEE-101')).toBe('FEE-101');
    }
  });
});
