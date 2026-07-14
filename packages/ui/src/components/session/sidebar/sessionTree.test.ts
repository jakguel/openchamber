import { describe, test, expect } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { partitionSessionTree } from './sessionTree';

const s = (id: string, opts: { parentID?: string; archived?: boolean } = {}): Session => {
  const obj: Record<string, unknown> = { id };
  if (opts.parentID !== undefined) obj.parentID = opts.parentID;
  if (opts.archived) obj.time = { archived: 1 };
  return obj as Session;
};

const noPins = new Set<string>();

describe('partitionSessionTree', () => {
  test('AC2: parentID-less sessions are always top-level roots', () => {
    const R1 = s('R1');
    const R2 = s('R2');
    const { roots, childrenByParentId } = partitionSessionTree([R1, R2], noPins);
    expect(roots).toEqual([R1, R2]);
    expect(childrenByParentId.size).toBe(0);
  });

  test('AC3: child with present parent and same archived-state nests, does not appear in roots', () => {
    const R1 = s('R1');
    const C = s('C', { parentID: 'R1' });
    const { roots, childrenByParentId } = partitionSessionTree([R1, C], noPins);
    expect(roots).toEqual([R1]);
    expect(roots).not.toContain(C);
    expect(childrenByParentId.get('R1')).toEqual([C]);
  });

  test('AC4: orphan (parent absent from list) is excluded from roots and childrenByParentId', () => {
    const C = s('C', { parentID: 'ghost' });
    const { roots, childrenByParentId } = partitionSessionTree([C], noPins);
    expect(roots).toEqual([]);
    expect(childrenByParentId.size).toBe(0);
  });

  test('AC5: archived-state mismatch (archived parent + active child) excludes child entirely', () => {
    const P = s('P', { archived: true });
    const C = s('C', { parentID: 'P' });
    const { roots, childrenByParentId } = partitionSessionTree([P, C], noPins);
    expect(roots).toEqual([P]);
    expect(roots).not.toContain(C);
    expect(childrenByParentId.size).toBe(0);
  });

  test('same archived-state (both archived) => child nests, not excluded', () => {
    const P = s('P', { archived: true });
    const C = s('C', { parentID: 'P', archived: true });
    const { roots, childrenByParentId } = partitionSessionTree([P, C], noPins);
    expect(roots).toEqual([P]);
    expect(childrenByParentId.get('P')).toEqual([C]);
  });

  test('child whose parent appears later in the array still nests', () => {
    const C = s('C', { parentID: 'P' });
    const P = s('P');
    const { roots, childrenByParentId } = partitionSessionTree([C, P], noPins);
    expect(roots).toEqual([P]);
    expect(childrenByParentId.get('P')).toEqual([C]);
    expect(roots).not.toContain(C);
  });
});
