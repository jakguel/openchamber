import { describe, expect, test } from 'bun:test';

import { useUIStore } from './useUIStore';

// These tests exercise the REAL persist `migrate` function (no mocks). The
// right-sidebar tab validation runs UNCONDITIONALLY inside migrate (not gated
// behind a version check), so we pass the current schema version so that only
// the tab-validation + sanitize/normalize passes run. Each assertion fails if
// the migration whitelist/fallback is wrong.

const getMigrate = () => {
  const { migrate, version } = useUIStore.persist.getOptions();
  if (!migrate) throw new Error('migrate not configured on useUIStore');
  if (typeof version !== 'number') throw new Error('persist version not a number');
  return { migrate, version };
};

const migrateRightSidebarTab = (persisted: Record<string, unknown>): unknown => {
  const { migrate, version } = getMigrate();
  const result = migrate({ contextPanelByDirectory: {}, ...persisted }, version) as {
    rightSidebarTab?: unknown;
  } | undefined;
  return result?.rightSidebarTab;
};

describe('useUIStore rightSidebarTab migration', () => {
  describe("AC2 — persisted 'context'/invalid migrates to 'files'", () => {
    test("persisted 'context' migrates to 'files'", () => {
      expect(migrateRightSidebarTab({ rightSidebarTab: 'context' })).toBe('files');
    });

    test('garbage numeric value migrates to \'files\'', () => {
      expect(migrateRightSidebarTab({ rightSidebarTab: 12345 })).toBe('files');
    });

    test('unknown string value migrates to \'files\'', () => {
      expect(migrateRightSidebarTab({ rightSidebarTab: 'totally-bogus' })).toBe('files');
    });

    test('missing/no persisted value resolves to \'files\'', () => {
      expect(migrateRightSidebarTab({})).toBe('files');
    });
  });

  describe('valid values are preserved', () => {
    test("'git' is preserved", () => {
      expect(migrateRightSidebarTab({ rightSidebarTab: 'git' })).toBe('git');
    });

    test("'files' is preserved", () => {
      expect(migrateRightSidebarTab({ rightSidebarTab: 'files' })).toBe('files');
    });
  });

  describe('AC1 — fresh store default', () => {
    test("fresh store initial rightSidebarTab is 'files'", () => {
      // getInitialState reflects the store's default before any persistence.
      expect(useUIStore.getInitialState().rightSidebarTab).toBe('files');
    });
  });
});
