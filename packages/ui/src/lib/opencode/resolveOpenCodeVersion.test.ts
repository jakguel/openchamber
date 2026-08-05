import { describe, test, expect } from 'bun:test';

import { resolveOpenCodeVersion } from './resolveOpenCodeVersion';

describe('resolveOpenCodeVersion', () => {
  test('returns the version string from a well-formed payload', () => {
    expect(resolveOpenCodeVersion({ version: '1.16.0' })).toBe('1.16.0');
  });

  test('trims surrounding whitespace', () => {
    expect(resolveOpenCodeVersion({ version: '  1.16.0  ' })).toBe('1.16.0');
  });

  test('returns null for a blank or whitespace-only version', () => {
    expect(resolveOpenCodeVersion({ version: '' })).toBeNull();
    expect(resolveOpenCodeVersion({ version: '   ' })).toBeNull();
  });

  test('returns null when the version field is missing', () => {
    expect(resolveOpenCodeVersion({})).toBeNull();
  });

  test('returns null when version is a non-string (e.g. server null)', () => {
    expect(resolveOpenCodeVersion({ version: null })).toBeNull();
    expect(resolveOpenCodeVersion({ version: 116 })).toBeNull();
    expect(resolveOpenCodeVersion({ version: { major: 1 } })).toBeNull();
  });

  test('returns null when the payload is null, undefined, or not an object', () => {
    expect(resolveOpenCodeVersion(null)).toBeNull();
    expect(resolveOpenCodeVersion(undefined)).toBeNull();
    expect(resolveOpenCodeVersion('1.16.0')).toBeNull();
  });
});
