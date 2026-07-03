import { beforeEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

beforeEach(() => {
  useUIStore.setState({ plantumlTheme: 'none' });
});

describe('useUIStore plantumlTheme', () => {
  test('default plantumlTheme is none', () => {
    expect(useUIStore.getState().plantumlTheme).toBe('none');
  });

  test('setPlantumlTheme updates plantumlTheme', () => {
    useUIStore.getState().setPlantumlTheme('toy');
    expect(useUIStore.getState().plantumlTheme).toBe('toy');
  });

  test('setPlantumlTheme accepts all valid union values', () => {
    const themes = ['none', 'plain', 'mono', 'sunlust', 'toy', 'reddress-lightblue'] as const;
    for (const theme of themes) {
      useUIStore.getState().setPlantumlTheme(theme);
      expect(useUIStore.getState().plantumlTheme).toBe(theme);
    }
  });

  test('partialize output includes plantumlTheme', () => {
    useUIStore.getState().setPlantumlTheme('sunlust');
    const partialize = useUIStore.persist.getOptions().partialize;
    if (!partialize) throw new Error('partialize must be defined');
    const partial = partialize(useUIStore.getState());
    expect((partial as Record<string, unknown>).plantumlTheme).toBe('sunlust');
  });
});
