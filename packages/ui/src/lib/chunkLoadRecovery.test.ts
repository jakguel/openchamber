import { describe, expect, test } from 'bun:test';

import { importWithChunkRecovery } from './chunkLoadRecovery';

describe('importWithChunkRecovery', () => {
  test('schedules recovery reload when stored reload marker is corrupt', async () => {
    const globalWithWindow = globalThis as unknown as { window?: unknown };
    // Other suites install a global `window` via Object.defineProperty with
    // `writable` defaulting to false, which makes a plain `globalThis.window = ...`
    // assignment silently no-op. Define the property explicitly so this test is
    // robust to that leaked non-writable descriptor.
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    let storedMarker: string | null = null;
    let reloadCount = 0;

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        sessionStorage: {
          getItem: () => '{not json',
          setItem: (_key: string, value: string) => {
            storedMarker = value;
          },
        },
        setTimeout: (callback: () => void) => {
          callback();
          return 0;
        },
        location: {
          reload: () => {
            reloadCount += 1;
          },
        },
      },
    });

    try {
      let caught: unknown;
      try {
        await importWithChunkRecovery(async () => {
          throw new Error('Failed to fetch dynamically imported module');
        }, { retries: 0 });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(storedMarker).not.toBeNull();
      expect(reloadCount).toBe(1);
    } finally {
      if (previousDescriptor) {
        Object.defineProperty(globalThis, 'window', previousDescriptor);
      } else {
        delete globalWithWindow.window;
      }
    }
  });
});
