# PlantUML error-diagram SVG fixtures — provenance

These two `.svg` files are **verbatim, unedited output of the real `@plantuml/core@1.2026.6`
engine** (TeaVM Java→JS + Viz.js), captured in headless Chromium through the exact production
render path (`loadEngine` → `renderToString`). They are NOT hand-written. They exist as
deterministic, engine-free inputs for the downstream extractor/mapper tasks (T2/T3) and are
loaded as raw strings via `index.ts` — no test imports the ~8.6 MB engine.

## Invalid snippet (both variants)

```
@startuml
rectangle "Box" as R
diamond "some label" as X
R --> X
@enduml
```

`diamond "some label" as X` is a real syntax error: a `diamond` node does not accept a quoted
display label. The engine returns an **error-diagram SVG** (not a valid render), colored
`#33FF02`/`#FF0000`/`#000000`, with an unresolved `PlantUML version $version$` footer, a
`Syntax Error?` marker, a `[From … (line N)]` source citation, and the offending line rendered
with `text-decoration="wavy underline"`.

## Variants

| File | Variant | Cited line | Notes |
|---|---|---|---|
| `error-diagram.no-theme.svg` | no theme | `[From textarea (line 3)]` | error is on original source line 3 |
| `error-diagram.theme-toy.svg` | `toy` theme active | `[From textarea (line 78)]` | theme body spliced after `@startuml` offsets the line |

Theme-active variant was produced through the same production theme path:
`rewriteLinetypeForLabels(spliceTheme(source, stripFrontMatter(toyRaw)))` rendered with
`dark:false` (a vendored theme renders in its own scheme). The `toy` theme body inserts
**75 lines** after the `@start` opener, so the engine cites line `3 + 75 = 78` for the same
offending token — this is exactly the themed→original line-mapping T3 must reverse.

## Citation label is `textarea`, not `string`

The real 1.2026.6 browser `renderToString` path labels the source origin **`textarea`**
(`[From textarea (line N)]`), NOT `[From string (line N)]`. Downstream parsing (T2) must match
the real label, not the illustrative `string` example in the task text. The production detection
regex `/\$version\$|\[from [^\]]*line \d|syntax error|assumed diagram/i` already matches this.

## API-probe finding (Oracle-confirmed)

`@plantuml/core@1.2026.6` exposes **NO cleaner text/utxt diagnostic API**. Its published
`exports` map (`node_modules/@plantuml/core/package.json`) and README confirm the entire public
surface is two functions from `plantuml.js`: `render(lines, targetId, { dark })` and
`renderToString(lines, onSuccess, onError, { dark })`. There is no `.txt`/`.utxt`/diagnostic
entry point — the ONLY way to obtain the engine's error information is to scan the error-diagram
SVG these fixtures capture. A PlantUML syntax error is also NOT delivered via `onError`; it
arrives at `onSuccess` as this error-diagram SVG.

## Regeneration

Throwaway (uncommitted) harness under `packages/ui/spike-plantuml/` (`capture.html`,
`src/capture.ts`, `capture.mjs`) drives the real engine and writes these files. It is deleted
after capture; only these fixtures, `index.ts`, `PROVENANCE.md`, and `fixtures.test.ts` are
committed.
