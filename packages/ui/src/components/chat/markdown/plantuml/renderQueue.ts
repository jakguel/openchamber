/**
 * Serialized single-flight render queue for the async PlantUML renderer.
 *
 * @plantuml/core renders asynchronously and shares mutable module-level globals, so
 * concurrent renders silently overwrite each other — they MUST be serialized. morphdom
 * also re-decorates the chat ~60/sec during streaming and REUSES DOM nodes, so a render
 * that resolves late must never be injected into a node that has moved on to a newer
 * source. This module encodes those invariants as pure logic, decoupled from the ~8.6MB
 * WASM engine via an injected `render` function (the only external boundary), so it is
 * fully unit-testable without the engine or a real DOM.
 *
 * Invariants:
 *  - single-flight: exactly one render runs at a time (never overlapping).
 *  - in-flight dedup: a second enqueue of an already pending/in-flight key attaches to
 *    the same promise (one underlying render per key).
 *  - latest-only backpressure: rapid enqueues for the same block supersede stale queued
 *    renders, so only the newest source per block survives and the queue stays bounded.
 *  - LRU + TTL cache (positive AND negative): a cached svg OR error is returned without
 *    re-queuing until it expires.
 *  - render-generation guard: every enqueue bumps a per-node generation and returns it;
 *    `isEligible` reports whether a resolved render may still be injected into its target
 *    node (node still connected AND its current key+generation still match).
 */

export type PlantumlRenderResult = { svg?: string; error?: string };

/**
 * The single external boundary: performs the actual (async) render. Injected so the
 * queue never imports the WASM engine and stays unit-testable. `key` is the cache/dedup
 * key (themeId:dark:source); `source`/`dark` are forwarded to the engine.
 */
export type PlantumlRenderFn = (
  key: string,
  source: string,
  dark: boolean,
  themeBody: string,
) => Promise<PlantumlRenderResult>;

/**
 * Minimal structural view of a target DOM node — the DOM is inverted here as an external
 * boundary. A real `Element` satisfies this; unit tests pass a plain `{ isConnected }`.
 */
export interface PlantumlTargetNode {
  readonly isConnected: boolean;
}

export interface EnqueueHandle {
  readonly key: string;
  readonly generation: number;
  readonly promise: Promise<PlantumlRenderResult>;
}

export interface PlantumlRenderQueueOptions {
  /** The only external boundary: performs the actual (async) render. */
  render: PlantumlRenderFn;
  /** Max entries in the LRU cache (positive + negative combined). Default 100. */
  cacheMax?: number;
  /** Time-to-live for a cached result, in ms. Default 5 minutes. */
  cacheTtlMs?: number;
  /** Injectable clock (external boundary) so TTL is deterministic in tests. Default Date.now. */
  now?: () => number;
}

export interface PlantumlRenderQueue {
  /**
   * Queue a render. Returns a generation token (for the injection guard) and the shared
   * result promise. `key` = themeId:dark:source; `node` is the block identity used for
   * latest-only backpressure and the generation guard.
   */
  enqueue(
    key: string,
    source: string,
    dark: boolean,
    themeBody: string,
    node?: PlantumlTargetNode | null,
  ): EnqueueHandle;
  /**
   * Whether a resolved render may still be injected into `node`: the node must still be
   * connected AND its current key+generation must still match the ones from enqueue.
   */
  isEligible(
    node: PlantumlTargetNode | null | undefined,
    key: string,
    generation: number,
  ): boolean;
  /** Number of blocks currently queued but not yet started (bounded by backpressure). */
  readonly pendingSize: number;
  /** Number of cached results (positive + negative). */
  readonly cacheSize: number;
}

const DEFAULT_CACHE_MAX = 100;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  result: PlantumlRenderResult;
  expiresAt: number;
}

type SettleResult = (result: PlantumlRenderResult | PromiseLike<PlantumlRenderResult>) => void;

interface PendingEntry {
  key: string;
  source: string;
  dark: boolean;
  themeBody: string;
  resolve: SettleResult;
  promise: Promise<PlantumlRenderResult>;
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export const createPlantumlRenderQueue = (
  options: PlantumlRenderQueueOptions,
): PlantumlRenderQueue => {
  const render = options.render;
  const cacheMax = options.cacheMax ?? DEFAULT_CACHE_MAX;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;

  // LRU + TTL cache holding both positive (svg) and negative (error) results.
  const cache = new Map<string, CacheEntry>();
  // Promise per key spanning pending + in-flight — the dedup surface (one render per key).
  const promiseByKey = new Map<string, Promise<PlantumlRenderResult>>();
  // Latest pending (not-yet-started) request per block. Kept small by backpressure.
  const pendingByBlock = new Map<object, PendingEntry>();
  // FIFO of block ids awaiting a render slot (each block appears at most once).
  const queue: object[] = [];
  // Per-node generation + current key for the injection guard. WeakMaps so detached nodes
  // are GC-eligible and the maps never grow unbounded under morphdom churn.
  const generationByNode = new WeakMap<PlantumlTargetNode, number>();
  const currentKeyByNode = new WeakMap<PlantumlTargetNode, string>();

  let scheduled = false;
  let nodelessCounter = 0;

  const getFreshCached = (key: string): PlantumlRenderResult | undefined => {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (now() >= entry.expiresAt) {
      cache.delete(key);
      return undefined;
    }
    // Refresh LRU recency: re-insert so this key becomes most-recently-used.
    cache.delete(key);
    cache.set(key, entry);
    return entry.result;
  };

  const setCached = (key: string, result: PlantumlRenderResult): void => {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, { result, expiresAt: now() + cacheTtlMs });
    while (cache.size > cacheMax) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    // Defer to a microtask so a synchronous burst of enqueues coalesces (latest-only)
    // before the first render starts.
    queueMicrotask(() => {
      void drain();
    });
  };

  const drain = async (): Promise<void> => {
    scheduled = false;
    while (queue.length > 0) {
      const blockId = queue.shift();
      if (blockId === undefined) break;
      const entry = pendingByBlock.get(blockId);
      if (!entry) continue;
      // Releasing the pending slot lets a newer source for this block re-queue mid-render.
      pendingByBlock.delete(blockId);

      let result: PlantumlRenderResult;
      try {
        result = await render(entry.key, entry.source, entry.dark, entry.themeBody);
      } catch (err) {
        result = { error: errorMessage(err) };
      }
      setCached(entry.key, result);
      promiseByKey.delete(entry.key);
      entry.resolve(result);
    }
  };

  const enqueue = (
    key: string,
    source: string,
    dark: boolean,
    themeBody: string,
    node?: PlantumlTargetNode | null,
  ): EnqueueHandle => {
    // Every enqueue expresses the node's LATEST intent — bump generation + current key
    // first so any older in-flight render becomes ineligible for injection.
    let generation: number;
    if (node) {
      generation = (generationByNode.get(node) ?? 0) + 1;
      generationByNode.set(node, generation);
      currentKeyByNode.set(node, key);
    } else {
      generation = ++nodelessCounter;
    }

    // 1. Fresh cache hit (positive OR negative) — never re-queue within TTL.
    const cached = getFreshCached(key);
    if (cached) {
      return { key, generation, promise: Promise.resolve(cached) };
    }

    // 2. In-flight / pending dedup by key — one underlying render per key.
    const existing = promiseByKey.get(key);
    if (existing) {
      return { key, generation, promise: existing };
    }

    // 3. Enqueue with latest-only backpressure keyed by block (the node identity).
    const blockId: object = node ?? {};
    let resolveFn!: SettleResult;
    const promise = new Promise<PlantumlRenderResult>((res) => {
      resolveFn = res;
    });
    const entry: PendingEntry = { key, source, dark, themeBody, resolve: resolveFn, promise };

    const prior = pendingByBlock.get(blockId);
    pendingByBlock.set(blockId, entry);
    promiseByKey.set(key, promise);
    if (prior) {
      // Supersede the stale queued render: forward its awaiters to the newest render (the
      // guard prevents any stale injection) and drop it from the dedup surface. The block
      // is already in `queue`, so we do NOT push it again — this bounds queue length.
      promiseByKey.delete(prior.key);
      prior.resolve(promise);
    } else {
      queue.push(blockId);
    }
    schedule();
    return { key, generation, promise };
  };

  const isEligible = (
    node: PlantumlTargetNode | null | undefined,
    key: string,
    generation: number,
  ): boolean => {
    if (!node) return false;
    if (!node.isConnected) return false;
    if (generationByNode.get(node) !== generation) return false;
    if (currentKeyByNode.get(node) !== key) return false;
    return true;
  };

  return {
    enqueue,
    isEligible,
    get pendingSize(): number {
      return pendingByBlock.size;
    },
    get cacheSize(): number {
      return cache.size;
    },
  };
};
