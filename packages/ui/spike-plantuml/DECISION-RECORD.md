# Task C0 — PlantUML spike decision record

Task `openchamber-f9d.16.1` · Story C (`openchamber-f9d.16`) · Epic `openchamber-f9d`.
Package under test: **`@plantuml/core@1.2026.6`** (MIT, TeaVM-compiled, browser-DOM engine).

This is a **throwaway proof harness**, not production wiring. It touches none of the five
shared Story-C files. Delete `packages/ui/spike-plantuml/` and `e2e/plantumlSpike.e2e.ts`
once Story C is decomposed.

## TL;DR (three blockers resolved)

| Blocker | Verdict |
|---|---|
| (a) stdlib sprites | Artifacts = per-library `*.min.js` from `plantuml/plantuml` repo `src/main/resources/teavm/`. Full set ~95 MB raw (unshippable). **Ship C4-first** (23.6 KB gz). Engine reads pre-injected `window.PLANTUML_STDLIB*` globals — **no network** in 1.2026.6. |
| (b) dark API | **Use `renderToString(lines, onSuccess, onError, { dark })`.** Empirically the 4th `options` arg IS honored in 1.2026.6 → renderToString is NOT light-only (this overturns the plan's assumption). Errors are content-detected, not via `onError`. |
| (c) loader dev+prod | **`<script src=viz-global.js?url>` (global `Viz`) THEN `await import('plantuml.js')`**, SSR-guarded. PROVEN in real Chromium under `vite dev` AND `vite build`+`vite preview` (2/2 e2e pass). Engine lands in a separate 6.4 MB async chunk; baseline entry = 5.8 KB. |

Run the proof: `bunx playwright test --config packages/ui/playwright.config.ts --project=chromium plantumlSpike`

---

## (a) Stdlib sprite bundles — source + measured sizes

**Artifact.** The prebuilt sprite bundles are per-library, self-contained IIFE `*.min.js`
files living in the PlantUML source tree: `plantuml/plantuml` → `src/main/resources/teavm/`.
Each file assigns `window.PLANTUML_STDLIB[_JSON|_INFO][<lib>]`. They are **excluded from the
`@plantuml/core` npm package** (PUBLISHING_NPM.md: the heavy `*.min.js` bundles "add ~95 MB
and are not part of the engine … remain available from the project site").

Obtainable from (all serve the same file): raw GitHub
`https://raw.githubusercontent.com/plantuml/plantuml/master/src/main/resources/teavm/<lib>.min.js`,
or jsDelivr `https://cdn.jsdelivr.net/gh/plantuml/plantuml@<tag>/src/main/resources/teavm/<lib>.min.js`.
**For a self-contained offline app, vendor the chosen files into the repo** (as this spike
vendors `public/c4.min.js`).

**How the engine consumes them (verified by decompiling `plantuml.js`):**
`window.PLANTUML_STDLIB[<lib>][<path>]` (raw `.puml` lines), `window.PLANTUML_STDLIB_JSON`,
`window.PLANTUML_STDLIB_INFO[<lib>]` (metadata). The shipped 1.2026.6 engine has **no
`loadOnce`/no hardcoded stdlib URL** — it only reads the pre-populated globals, so injecting
them yields fully offline sprite resolution (PROVEN: the C4 sample renders from
`public/c4.min.js` with zero external network requests).

**Measured sizes** (raw bytes from GitHub, gzip -9):

| requested set | file | raw | **gzip** |
|---|---|---:|---:|
| **C4** | `c4.min.js` | 181,698 | **23,604** (~23 KB) |
| Azure | `azure.min.js` | 532,887 | 152,132 (~149 KB) |
| k8s (aliases) | `k8s.min.js` | 50,160 | 22,753 (~22 KB) |
| Kubernetes (icons) | `kubernetes.min.js` | 307,369 | 225,781 (~220 KB) |
| GCP | `gcp.min.js` | 279,084 | 49,511 (~48 KB) |
| **AWS** (awslib v14) | `awslib14.min.js` | 8,188,110 | **4,854,186 (~4.6 MB)** |
| AWS (awslib v20) | `awslib20.min.js` | 10,182,413 | ~6 MB (raw) |
| **tupadr3** (devicons + font-awesome) | `tupadr3.min.js` | 20,227,666 | **1,983,607 (~1.9 MB)** |
| IBM | `ibm.min.js` | 23,636,085 | (raw ~23 MB) |
| material | `material7.4.47.min.js` | 17,151,755 | (raw ~17 MB) |

Notes: `awslib.min.js` (1.9 KB) is only a tiny alias stub — the real AWS sprites are
`awslib10/14/20`. **`font-awesome` and `devicons` are BOTH inside the single `tupadr3.min.js`**
(namespaces `tupadr3/font-awesome`, `tupadr3/font-awesome-5`, `tupadr3/devicons`,
`tupadr3/devicons2`); shipping font-awesome alone requires repackaging that one file.

**Recommendation — C4-first MVP.**
- MVP: vendor **`c4.min.js` only** (23.6 KB gz) — C4 is the epic's headline use case and its cost
  is negligible next to the ~2 MB-gz engine chunk.
- Cheap optional add-on (still trivial): C4 + Azure + k8s + GCP ≈ **243 KB gz**.
- **Defer the heavy sets** (AWS ~4.6 MB gz, tupadr3 ~1.9 MB gz, IBM, material). If needed later,
  load the specific `<lib>.min.js` as its own on-demand chunk keyed off the diagram's
  `!include <lib/…>` — do NOT baseline them.

---

## (b) Dark-mode API — `renderToString` with the 4th options arg

**Decision: use `renderToString(lines, onSuccess, onError, { dark })`.**

The two candidate APIs (both async, both share mutable engine globals → renders MUST be serialized):

- `render(lines, targetId, { dark })` → writes SVG into `#targetId` later; **no error callback**.
- `renderToString(lines, onSuccess, onError, options)` → delivers the SVG **as a string** to
  `onSuccess`; `options` is a 4th arg (documented for 1.2026.7beta2, present and working in 1.2026.6).

**Empirical result (real Chromium, dev + prod, identical):** for the same sequence source,
- light color-set: `#000000, #181818, #E2E2F0`
- `render(..., {dark:true})` color-set: `#222222, #E7E7E7, #FFFFFF`
- `renderToString(..., {dark:true})` color-set: `#222222, #E7E7E7, #FFFFFF` → **identical to render()'s dark.**

So **renderToString honors `{dark:true}` reliably** — the plan's premise that renderToString is
"undocumented/unreliable/light-only" and that dark forces `render()`-into-DOM is **DISPROVEN for
1.2026.6**. renderToString is preferred because it returns a **string** (mirrors the synchronous
`renderMermaidSVG(src) → string` twin-of-Mermaid contract: the async `renderPlantuml` slot resolves
to a string, then `decoratePlantuml` injects it — no live target-id/MutationObserver needed) and it
still exposes an `onError` channel.

**Error surfacing (never a perpetual spinner) — important gotcha:**
A PlantUML **syntax error is NOT delivered via `onError`.** Both APIs return an **error-diagram
SVG**: `onSuccess` fires (`ok:true`) with an SVG whose color-set is `#000000, #33FF02, #FF0000` and
whose text contains an unresolved `PlantUML version $version$ …` footer and a `[From … (line N)`
source citation. Therefore the error affordance MUST be **content-based**:

1. Wrap the call in a promise; `onError` rejects (catastrophic/engine failure), `onSuccess` resolves.
2. Add a **timeout** (spike uses 20 s) → reject on timeout so a stuck render shows an error, never spins.
3. On resolve, run an **error-signature detector** on the returned SVG; if it matches, render the
   error affordance instead of injecting the diagram. Spike detector:
   `/\$version\$|\[from [^\]]*line \d|syntax error|assumed diagram/i` (refine/pin in Story C).

Recommended production wrapper (validated shape):

```ts
function renderPlantumlToString(
  engine: PlantUmlEngine,
  source: string,
  opts: { dark?: boolean },
  timeoutMs = 15_000,
): Promise<{ svg: string; isError: boolean }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (v: { svg: string; isError: boolean }) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => { if (!settled) { settled = true; reject(new Error('plantuml render timeout')); } }, timeoutMs);
    try {
      engine.renderToString(
        source.split(/\r\n|\r|\n/),
        (svg) => done({ svg, isError: isPlantumlError(svg) }), // syntax errors arrive HERE, not onError
        (msg) => { if (!settled) { settled = true; clearTimeout(t); reject(new Error(msg)); } },
        opts, // { dark } — the 4th arg IS honored in 1.2026.6
      );
    } catch (e) { if (!settled) { settled = true; clearTimeout(t); reject(e as Error); } }
  });
}
```

MVP dark mode stays **binary** (`{ dark: boolean }` from the app light/dark theme). Per-theme
skinparam color-matching remains out of scope (unproven) — as the plan already scoped.

---

## (c) Loader — viz-global before plantuml.js, dev AND prod

**Decision: load `viz-global.js` via a classic `<script src=…?url>` (await onload), THEN
`await import('@plantuml/core/plantuml.js')`; both behind a `typeof window` SSR guard.**
See `src/loadEngine.ts`.

Why: `viz-global.js` is a **UMD bundle** whose global branch (`(globalThis||self).Viz = …`) runs
deterministically only when executed as a classic script; `plantuml.js` is an **ESM module** that
reads the bare global `Viz`. Importing viz-global as an ESM module risks esbuild/rollup UMD-interop
rewriting `exports`/`module`, which could skip the global branch differently in dev vs prod — the
exact loader risk Oracle flagged. The `?url` + `<script>` approach matches the package's intended
usage and is dev/prod-identical. `@plantuml/core` marks `sideEffects: ["./viz-global.js"]`.

**Proof (real Chromium, `e2e/plantumlSpike.e2e.ts`, 2/2 pass):**
- `vite DEV` (createServer): engine loads, `window.Viz` present, sequence + C4 render to `<svg>`,
  dark differs from light, invalid source flagged as error, **0 external network requests**.
- `vite build` + `vite preview`: same assertions pass, AND the build manifest proves chunk isolation.

**Bundle / chunk isolation (AC4):** engine raw = `plantuml.js` 7.15 MB + `viz-global.js` 1.45 MB ≈
8.6 MB (gzip ≈ 1.39 MB + 0.60 MB ≈ **2.0 MB**). Production `vite build` output:

| dist asset | bytes | role |
|---|---:|---|
| `main-*.js` (baseline entry) | **5,813** | app entry — engine ABSENT |
| `plantuml-*.js` | 6,398,468 | engine — separate ASYNC chunk (dynamic import) |
| `viz-global-*.js` | 1,445,436 | Viz — separate asset (`?url`) |

`@plantuml/core` is a **pinned** dep (`"@plantuml/core": "1.2026.6"`, exact) and is imported nowhere
in `packages/ui/src` or `packages/web/src` — so it is unreachable from the app baseline bundle.

**Real-app wiring note for Story C:** add `@plantuml/core` to `optimizeDeps.exclude` in
`packages/web/vite.config.ts` (as this harness does) so dev never prebundles the 7 MB engine and it
stays a true dynamic chunk.

---

## Decomposition guidance for the rest of Story C (AC5)

1. **Loader module**: port `src/loadEngine.ts` (script-tag `?url` viz-global → dynamic `import` plantuml,
   SSR-guarded, single cached `enginePromise`). Add `@plantuml/core` to web vite `optimizeDeps.exclude`.
2. **Async slot**: `renderPlantuml` resolves to a **string** via the `renderToString` wrapper above
   (dark honored; timeout; content-based error detection). Keeps the twin-of-Mermaid string contract.
3. **Serialize** all renders (shared engine globals) via the single-flight queue + latest-only
   backpressure + LRU/TTL pos/neg cache the plan already specifies. Cache the error-detected result
   negatively so error SVGs don't re-queue.
4. **Error affordance**: treat `isPlantumlError(svg) === true` as the negative/error path (render an
   explicit error block), plus timeout/`onError` → error. Never leave a spinner.
5. **Stdlib**: vendor `c4.min.js` into the app (MVP), inject its globals once before first render
   (a `<script>` tag or eval), gated to when a plantuml block is present. Defer AWS/tupadr3/IBM/material.
6. **Security (unchanged from plan)**: DOMPurify SVG pass on the string before injection; block all
   network-capable includes; strip remote `<image>/<use>` hrefs, `<foreignObject>`, `<script>`, CSS
   `url()`. Note the engine itself makes no network calls in 1.2026.6, but sanitize defensively.
7. **Verify** with Playwright real Chromium (this harness's assertions are the template); jsdom is
   invalid (`getBBox` returns 0).
