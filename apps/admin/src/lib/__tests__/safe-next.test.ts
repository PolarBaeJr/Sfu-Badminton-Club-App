import { describe, expect, it } from 'vitest';
import { sanitizeNext } from '../safe-next';

describe('sanitizeNext', () => {
  it('keeps a same-app path', () => {
    expect(sanitizeNext('/players?tab=1')).toBe('/players?tab=1');
  });
  it('falls back to the dashboard for nothing', () => {
    expect(sanitizeNext(null)).toBe('/dashboard');
    expect(sanitizeNext(undefined)).toBe('/dashboard');
    expect(sanitizeNext('')).toBe('/dashboard');
  });
  it('refuses anything that could leave the app', () => {
    expect(sanitizeNext('//evil.example.invalid')).toBe('/dashboard');
    expect(sanitizeNext('/\\evil.example.invalid')).toBe('/dashboard');
    expect(sanitizeNext('https://evil.example.invalid')).toBe('/dashboard');
    expect(sanitizeNext('players')).toBe('/dashboard');
  });
});
