import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from '../stores/useUIStore';
import { useSessionUIStore } from './session-ui-store';

const DIR = '/repo';
const A = 'ses_switchcount_a';
const B = 'ses_switchcount_b';
const BASE = 'ses_switchcount_base';

const restoresOf = (id: string): number => counted.filter((r) => r === id).length;

let counted: Array<string | null> = [];
const origRestore = useUIStore.getState().restoreForSessionSwitch;
useUIStore.setState({
  restoreForSessionSwitch: (sessionId: string | null, dir?: string | null) => {
    counted.push(sessionId);
    return origRestore(sessionId, dir);
  },
});

const switchTo = (id: string | null) => useSessionUIStore.getState().setCurrentSession(id, DIR);

describe('setCurrentSession -> restoreForSessionSwitch invocation invariants', () => {
  beforeEach(() => {
    switchTo(BASE);
    counted = [];
  });

  test('a distinct-id switch fires restoreForSessionSwitch exactly once', () => {
    switchTo(A);
    switchTo(B);
    expect(restoresOf(B)).toBe(1);
  });

  test('re-selecting the current session does not re-restore', () => {
    switchTo(B);
    counted = [];
    switchTo(B);
    expect(counted.length).toBe(0);
  });

  test('two restores of one id require re-entry via a non-null interstitial', () => {
    switchTo(A);
    switchTo(B);
    switchTo(A);
    counted = [];
    switchTo(B);
    switchTo(A);
    switchTo(B);
    expect(restoresOf(B)).toBe(2);
  });

  test('a null interstitial re-select restores the target once', () => {
    switchTo(B);
    switchTo(A);
    switchTo(B);
    counted = [];
    switchTo(null);
    switchTo(B);
    expect(restoresOf(B)).toBe(1);
  });
});
