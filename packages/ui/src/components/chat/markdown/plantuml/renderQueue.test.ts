import { describe, expect, test } from 'bun:test';

import {
  createPlantumlRenderQueue,
  type PlantumlRenderResult,
  type PlantumlTargetNode,
} from './renderQueue';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const connected = (): PlantumlTargetNode => ({ isConnected: true });

describe('createPlantumlRenderQueue — AC1 single-flight serialization', () => {
  test('two enqueues for different keys never render concurrently (fails if not serialized)', async () => {
    let active = 0;
    let maxActive = 0;
    const gates: Array<() => void> = [];
    const render = (_key: string, source: string): Promise<PlantumlRenderResult> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<PlantumlRenderResult>((resolve) => {
        gates.push(() => {
          active -= 1;
          resolve({ svg: source });
        });
      });
    };
    const queue = createPlantumlRenderQueue({ render });

    const h1 = queue.enqueue('t:false:A', 'A', false, connected());
    const h2 = queue.enqueue('t:false:B', 'B', false, connected());

    await tick();
    expect(gates.length).toBe(1);
    expect(active).toBe(1);

    gates[0]();
    await tick();
    expect(gates.length).toBe(2);

    gates[1]();
    await Promise.all([h1.promise, h2.promise]);
    expect(maxActive).toBe(1);
  });
});

describe('createPlantumlRenderQueue — AC2 in-flight dedup', () => {
  test('a second enqueue of an in-flight key returns the same promise, render runs once', async () => {
    let calls = 0;
    const gate = deferred<PlantumlRenderResult>();
    const render = (): Promise<PlantumlRenderResult> => {
      calls += 1;
      return gate.promise;
    };
    const queue = createPlantumlRenderQueue({ render });

    const h1 = queue.enqueue('t:false:S', 'S', false, connected());
    await tick();
    expect(calls).toBe(1);

    const h2 = queue.enqueue('t:false:S', 'S', false, connected());
    expect(h2.promise).toBe(h1.promise);
    expect(calls).toBe(1);

    gate.resolve({ svg: 'S' });
    const [r1, r2] = await Promise.all([h1.promise, h2.promise]);
    expect(r1).toEqual({ svg: 'S' });
    expect(r2).toEqual({ svg: 'S' });
  });

  test('dedup also holds while the key is still queued (before it starts)', async () => {
    let calls = 0;
    const render = async (_key: string, source: string): Promise<PlantumlRenderResult> => {
      calls += 1;
      return { svg: source };
    };
    const queue = createPlantumlRenderQueue({ render });

    const h1 = queue.enqueue('t:false:S', 'S', false, connected());
    const h2 = queue.enqueue('t:false:S', 'S', false, connected());
    expect(h2.promise).toBe(h1.promise);

    await Promise.all([h1.promise, h2.promise]);
    expect(calls).toBe(1);
  });
});

describe('createPlantumlRenderQueue — AC3 latest-only backpressure', () => {
  test('a synchronous burst on one block coalesces to only the newest source (fails if supersede removed)', async () => {
    const rendered: string[] = [];
    const render = async (_key: string, source: string): Promise<PlantumlRenderResult> => {
      rendered.push(source);
      return { svg: source };
    };
    const queue = createPlantumlRenderQueue({ render });
    const node = connected();

    queue.enqueue('t:false:A', 'A', false, node);
    queue.enqueue('t:false:B', 'B', false, node);
    const latest = queue.enqueue('t:false:C', 'C', false, node);
    expect(queue.pendingSize).toBe(1);

    await latest.promise;
    await tick();
    expect(rendered).toEqual(['C']);
  });

  test('a stale queued source is dropped while another block renders (fails if supersede removed)', async () => {
    const rendered: string[] = [];
    const firstGate = deferred<PlantumlRenderResult>();
    let calls = 0;
    const render = (_key: string, source: string): Promise<PlantumlRenderResult> => {
      rendered.push(source);
      calls += 1;
      return calls === 1 ? firstGate.promise : Promise.resolve({ svg: source });
    };
    const queue = createPlantumlRenderQueue({ render });
    const block1 = connected();
    const block2 = connected();

    queue.enqueue('t:false:1a', '1a', false, block1);
    await tick();
    expect(rendered).toEqual(['1a']);

    queue.enqueue('t:false:2a', '2a', false, block2);
    queue.enqueue('t:false:2b', '2b', false, block2);
    expect(queue.pendingSize).toBe(1);

    firstGate.resolve({ svg: '1a' });
    await tick();
    await tick();
    expect(rendered).toEqual(['1a', '2b']);
  });
});

describe('createPlantumlRenderQueue — AC4 LRU + TTL positive/negative cache', () => {
  test('a cached error is not re-queued within TTL but is after expiry (fails if neg-cache or TTL removed)', async () => {
    let clock = 0;
    const calls: Record<string, number> = {};
    const render = async (_key: string, source: string): Promise<PlantumlRenderResult> => {
      calls[source] = (calls[source] ?? 0) + 1;
      return { error: `bad:${source}` };
    };
    const queue = createPlantumlRenderQueue({ render, cacheTtlMs: 100, now: () => clock });
    const node = connected();

    const r1 = await queue.enqueue('t:false:E', 'E', false, node).promise;
    expect(r1).toEqual({ error: 'bad:E' });
    expect(calls.E).toBe(1);

    const r2 = await queue.enqueue('t:false:E', 'E', false, node).promise;
    expect(r2).toEqual({ error: 'bad:E' });
    expect(calls.E).toBe(1);

    clock = 150;
    const r3 = await queue.enqueue('t:false:E', 'E', false, node).promise;
    expect(r3).toEqual({ error: 'bad:E' });
    expect(calls.E).toBe(2);
  });

  test('LRU evicts the oldest entry and recency-refresh protects a re-read key (fails if LRU/refresh removed)', async () => {
    const calls: Record<string, number> = {};
    const render = async (_key: string, source: string): Promise<PlantumlRenderResult> => {
      calls[source] = (calls[source] ?? 0) + 1;
      return { svg: source };
    };
    const queue = createPlantumlRenderQueue({ render, cacheMax: 2, cacheTtlMs: 1_000_000, now: () => 0 });
    const node = connected();

    await queue.enqueue('t:false:A', 'A', false, node).promise;
    await queue.enqueue('t:false:B', 'B', false, node).promise;
    expect(queue.cacheSize).toBe(2);

    await queue.enqueue('t:false:A', 'A', false, node).promise;
    expect(calls.A).toBe(1);

    await queue.enqueue('t:false:C', 'C', false, node).promise;
    expect(queue.cacheSize).toBe(2);

    await queue.enqueue('t:false:A', 'A', false, node).promise;
    expect(calls.A).toBe(1);

    await queue.enqueue('t:false:B', 'B', false, node).promise;
    expect(calls.B).toBe(2);
    expect(queue.cacheSize).toBe(2);
  });
});

describe('createPlantumlRenderQueue — AC5 render-generation guard', () => {
  test('eligibility requires connected node, matching key, and current generation', async () => {
    const render = async (): Promise<PlantumlRenderResult> => ({ svg: 'x' });
    const queue = createPlantumlRenderQueue({ render });
    const node = connected();

    const h1 = queue.enqueue('t:false:S1', 'S1', false, node);
    expect(queue.isEligible(node, 't:false:S1', h1.generation)).toBe(true);
    expect(queue.isEligible(node, 't:false:OTHER', h1.generation)).toBe(false);

    const detached: PlantumlTargetNode = { isConnected: false };
    const hd = queue.enqueue('t:false:D', 'D', false, detached);
    expect(queue.isEligible(detached, 't:false:D', hd.generation)).toBe(false);

    const h2 = queue.enqueue('t:false:S2', 'S2', false, node);
    expect(h2.generation).toBeGreaterThan(h1.generation);
    expect(queue.isEligible(node, 't:false:S1', h1.generation)).toBe(false);
    expect(queue.isEligible(node, 't:false:S2', h2.generation)).toBe(true);

    expect(queue.isEligible(null, 't:false:S2', h2.generation)).toBe(false);

    await tick();
  });
});
