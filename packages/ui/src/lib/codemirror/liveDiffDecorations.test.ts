import { afterAll, describe, expect, test } from "bun:test"
import type { EditorState } from "@codemirror/state"
import { EditorState as State } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"

import { buildExternalUpdateTransaction, computeLineDiff } from "@/components/ui/codeMirrorExternalUpdate"

import {
  LIVE_DIFF_CONCURRENT_COLLAPSE_CAP,
  LIVE_DIFF_FLASH_DURATION_MS,
  LIVE_DIFF_FLASH_FADE_MS,
  LIVE_DIFF_FLASH_HOLD_MS,
  LIVE_DIFF_MAX_ANIMATED_CHANGES,
  addLiveDiffEffect,
  applyLiveDiffDecorations,
  buildLiveDiffDecorations,
  cancelPriorLiveDiffClearTimers,
  clearLiveDiffEffect,
  clearPriorLiveDiffEffect,
  computeLiveDiffPlan,
  countActiveCollapses,
  liveDiffDecorationsExtension,
  liveDiffField,
  planLiveDiffAnimation,
  prefersReducedMotion,
  registerLiveDiffClearTimers,
  scheduleLiveDiffClears,
  type LiveDiffPlan,
} from "./liveDiffDecorations"

const stateWith = (doc: string): EditorState =>
  State.create({ doc, extensions: [liveDiffDecorationsExtension()] })

const specClasses = (state: EditorState): string[] => {
  const set = state.field(liveDiffField)
  const out: string[] = []
  const iter = set.iter()
  while (iter.value) {
    const cls = (iter.value.spec as { class?: string }).class
    if (cls) out.push(cls)
    iter.next()
  }
  return out
}

const hasDecoClassAt = (state: EditorState, from: number, cls: string): boolean => {
  const set = state.field(liveDiffField)
  let found = false
  const iter = set.iter()
  while (iter.value) {
    if (iter.from === from && (iter.value.spec as { class?: string }).class === cls) found = true
    iter.next()
  }
  return found
}

const widgetRangeCount = (ranges: ReturnType<typeof buildLiveDiffDecorations>["ranges"]): number =>
  ranges.filter((r) => (r.value.spec as { widget?: unknown }).widget != null).length

describe("computeLiveDiffPlan", () => {
  test("a pure add maps to a new-doc line-range flash anchor", () => {
    const plan = computeLiveDiffPlan(computeLineDiff("a\nb", "a\nX\nb"))
    expect(plan.addedLines).toEqual([{ startLine: 1, endLine: 2 }])
    expect(plan.removals).toEqual([])
    expect(plan.replacedLines).toEqual([])
  })

  test("a pure remove maps to a new-doc collapse anchor at the surviving line", () => {
    const plan = computeLiveDiffPlan(computeLineDiff("a\nX\nb", "a\nb"))
    expect(plan.removals).toEqual([{ atLine: 1, lines: ["X"] }])
    expect(plan.addedLines).toEqual([])
    expect(plan.replacedLines).toEqual([])
  })

  test("a high-similarity edit maps to a replace with the old/new line content", () => {
    const plan = computeLiveDiffPlan(computeLineDiff("hello world", "hello there"))
    expect(plan.replacedLines).toHaveLength(1)
    expect(plan.replacedLines[0]).toEqual({
      startLine: 0,
      endLine: 1,
      oldLines: ["hello world"],
      newLines: ["hello there"],
    })
  })

  test("append after the last line anchors the collapse at the doc end (atLine === new line count)", () => {
    // Removing the trailing line: "a\nb\nc" -> "a\nb" removes line index 2 (0-based), the new doc has 2 lines.
    const plan = computeLiveDiffPlan(computeLineDiff("a\nb\nc", "a\nb"))
    expect(plan.removals).toEqual([{ atLine: 2, lines: ["c"] }])
  })
})

describe("liveDiffField add/clear lifecycle (real CM state, no DOM)", () => {
  test("an added line gets a .cm-line-added decoration that is present, then absent after the flash clear", () => {
    const newContent = "a\nX\nb"
    const state = stateWith(newContent)
    const plan = computeLiveDiffPlan(computeLineDiff("a\nb", newContent))
    const { ranges } = buildLiveDiffDecorations(state, plan, { gen: 1, activeCollapses: 0 })

    const present = state.update({ effects: addLiveDiffEffect.of(ranges) }).state
    const addedLineFrom = present.doc.line(2).from // 0-based line 1 -> 1-based line 2 ("X")
    expect(hasDecoClassAt(present, addedLineFrom, "cm-line-added")).toBe(true)

    const cleared = present.update({
      effects: clearLiveDiffEffect.of({ gen: 1, kinds: ["flash", "underline"] }),
    }).state
    expect(specClasses(cleared)).not.toContain("cm-line-added")
  })

  test("a replaced line gets both the green flash line class AND a distinct underline span class", () => {
    const newContent = "hello there"
    const state = stateWith(newContent)
    const plan = computeLiveDiffPlan(computeLineDiff("hello world", newContent))
    const { ranges } = buildLiveDiffDecorations(state, plan, { gen: 3, activeCollapses: 0 })

    const present = state.update({ effects: addLiveDiffEffect.of(ranges) }).state
    const classes = specClasses(present)
    expect(classes).toContain("cm-line-added")
    expect(classes).toContain("cm-live-diff-replaced-span")

    // The underline span is NOT a whole-line decoration: it starts past the shared "hello " prefix.
    const set = present.field(liveDiffField)
    let underlineFrom = -1
    const iter = set.iter()
    while (iter.value) {
      if ((iter.value.spec as { class?: string }).class === "cm-live-diff-replaced-span") underlineFrom = iter.from
      iter.next()
    }
    expect(underlineFrom).toBe(present.doc.line(1).from + "hello ".length)
  })

  test("clear is generation-scoped: a stale clear does NOT remove a newer batch", () => {
    const newContent = "a\nX\nb"
    const state = stateWith(newContent)
    const plan = computeLiveDiffPlan(computeLineDiff("a\nb", newContent))
    const batch2 = buildLiveDiffDecorations(state, plan, { gen: 2, activeCollapses: 0 })

    const present = state.update({ effects: addLiveDiffEffect.of(batch2.ranges) }).state
    // A clear for a DIFFERENT generation must be a no-op for gen 2.
    const stale = present.update({
      effects: clearLiveDiffEffect.of({ gen: 1, kinds: ["flash", "underline"] }),
    }).state
    expect(specClasses(stale)).toContain("cm-line-added")
  })
})

describe("concurrent-collapse cap (R1 scroll-oscillation mitigation)", () => {
  const buildRemovalPlan = (n: number): { doc: string; plan: LiveDiffPlan } => {
    const doc = Array.from({ length: n }, (_, i) => `line${i}`).join("\n")
    const plan: LiveDiffPlan = {
      addedLines: [],
      replacedLines: [],
      removals: Array.from({ length: n }, (_, i) => ({ atLine: i, lines: [`old${i}`] })),
    }
    return { doc, plan }
  }

  test("above the cap, only cap widgets are created; the overflow removals are instant (no widget)", () => {
    const n = LIVE_DIFF_CONCURRENT_COLLAPSE_CAP + 4
    const { doc, plan } = buildRemovalPlan(n)
    const state = stateWith(doc)

    const { ranges, addedCollapses } = buildLiveDiffDecorations(state, plan, { gen: 1, activeCollapses: 0 })
    expect(addedCollapses).toBe(LIVE_DIFF_CONCURRENT_COLLAPSE_CAP)
    expect(widgetRangeCount(ranges)).toBe(LIVE_DIFF_CONCURRENT_COLLAPSE_CAP)
    // Overflow removals (n = cap + 4) created NO extra widgets.
    expect(widgetRangeCount(ranges)).toBe(n - 4)
  })

  test("when already at the cap, a new batch collapses nothing (all instant)", () => {
    const { doc, plan } = buildRemovalPlan(3)
    const state = stateWith(doc)
    const { addedCollapses } = buildLiveDiffDecorations(state, plan, {
      gen: 2,
      activeCollapses: LIVE_DIFF_CONCURRENT_COLLAPSE_CAP,
    })
    expect(addedCollapses).toBe(0)
  })

  test("countActiveCollapses reflects live widget count and drops to 0 after the collapse clear", () => {
    const { doc, plan } = buildRemovalPlan(LIVE_DIFF_CONCURRENT_COLLAPSE_CAP + 2)
    const state = stateWith(doc)
    const { ranges } = buildLiveDiffDecorations(state, plan, { gen: 5, activeCollapses: 0 })

    const present = state.update({ effects: addLiveDiffEffect.of(ranges) }).state
    expect(countActiveCollapses(present.field(liveDiffField))).toBe(LIVE_DIFF_CONCURRENT_COLLAPSE_CAP)

    const cleared = present.update({ effects: clearLiveDiffEffect.of({ gen: 5, kinds: ["collapse"] }) }).state
    expect(countActiveCollapses(cleared.field(liveDiffField))).toBe(0)
  })
})

describe("WI4 reduced-motion + large-diff instant-apply gate", () => {
  const originalWindow = globalThis.window

  const installMatchMedia = (reduced: boolean) => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { matchMedia: (q: string) => ({ matches: q.includes("reduce") ? reduced : false }) },
    })
  }

  afterAll(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow })
  })

  // Mirror EXACTLY what CodeMirrorEditor's external-update effect does at the seam:
  //   const animate = !prefersReducedMotion();
  //   const plan = animate ? planLiveDiffAnimation(old, next) : null;
  // then WI3 paints decorations only when plan != null.
  const decorationClassesForExternalUpdate = (oldText: string, newText: string): string[] => {
    const animate = !prefersReducedMotion()
    const plan = animate ? planLiveDiffAnimation(oldText, newText) : null
    if (!plan) return []
    const state = State.create({ doc: newText, extensions: [liveDiffDecorationsExtension()] })
    const { ranges } = buildLiveDiffDecorations(state, plan, { gen: 1, activeCollapses: 0 })
    const present = state.update({ effects: addLiveDiffEffect.of(ranges) }).state
    return specClasses(present)
  }

  const largeOld = "start"
  const largeNew = Array.from({ length: LIVE_DIFF_MAX_ANIMATED_CHANGES + 50 }, (_, i) => `line ${i}`).join("\n")

  test("the change ceiling is a conservative positive constant", () => {
    expect(LIVE_DIFF_MAX_ANIMATED_CHANGES).toBeGreaterThan(0)
    expect(Number.isInteger(LIVE_DIFF_MAX_ANIMATED_CHANGES)).toBe(true)
  })

  test("prefersReducedMotion reflects the matchMedia(prefers-reduced-motion: reduce) result", () => {
    installMatchMedia(true)
    expect(prefersReducedMotion()).toBe(true)
    installMatchMedia(false)
    expect(prefersReducedMotion()).toBe(false)
  })

  test("AC1: reduced-motion routes a small diff to the instant path (zero animation decorations)", () => {
    installMatchMedia(true)
    expect(decorationClassesForExternalUpdate("a\nb", "a\nX\nb")).not.toContain("cm-line-added")
  })

  test("AC2: a change count above the ceiling routes to the instant path even with motion allowed", () => {
    installMatchMedia(false)
    expect(planLiveDiffAnimation(largeOld, largeNew)).toBeNull()
    expect(decorationClassesForExternalUpdate(largeOld, largeNew)).not.toContain("cm-line-added")
  })

  test("AC3: below the ceiling with motion allowed still animates (WI3 decorations present)", () => {
    installMatchMedia(false)
    const plan = planLiveDiffAnimation("a\nb", "a\nX\nb")
    expect(plan).not.toBeNull()
    expect(decorationClassesForExternalUpdate("a\nb", "a\nX\nb")).toContain("cm-line-added")
  })

  test("AC4: the instant path still applies the correct final content via the mapped transaction", () => {
    for (const [oldText, newText] of [
      ["a\nb", "a\nX\nb"],
      [largeOld, largeNew],
    ] as const) {
      const base = State.create({ doc: oldText })
      const result = buildExternalUpdateTransaction(base.doc, newText, base.selection)
      expect(result).not.toBeNull()
      const applied = base.update({ changes: result!.changes }).state
      expect(applied.doc.toString()).toBe(newText)
    }
  })
})

describe("flash timing", () => {
  test("the flash hold + fade split is the mandated 2000ms + 800ms = 2800ms", () => {
    expect(LIVE_DIFF_FLASH_HOLD_MS).toBe(2000)
    expect(LIVE_DIFF_FLASH_FADE_MS).toBe(800)
    expect(LIVE_DIFF_FLASH_DURATION_MS).toBe(2800)
  })

  test("collapse clears before the flash, and the flash clear fires after the flash duration", async () => {
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
    const calls: Array<{ gen: number; kinds: string[] }> = []
    scheduleLiveDiffClears(9, (payload) => calls.push({ gen: payload.gen, kinds: [...payload.kinds] }), {
      collapseMs: 5,
      flashMs: 20,
    })

    await sleep(10)
    expect(calls).toEqual([{ gen: 9, kinds: ["collapse"] }])

    await sleep(20)
    expect(calls.some((c) => c.kinds.includes("flash") && c.kinds.includes("underline"))).toBe(true)
    expect(calls).toHaveLength(2)
  })
})

// AC3 clean-cancel: when a second external change lands before the first
// animation's timers fire, the superseding generation must remove gen-1's
// decorations AND cancel gen-1's pending clear timers — latest-wins with no
// stale overlap. Drives the REAL liveDiffField / applyLiveDiffDecorations /
// scheduleLiveDiffClears + timer-registry path (no DOM, no internal mocks); the
// EditorView shell is doubled at the CM I/O boundary only.
const makeStubView = (doc: string): { view: EditorView; getState: () => EditorState } => {
  let state = State.create({ doc, extensions: [liveDiffDecorationsExtension()] })
  const view = {
    get state() {
      return state
    },
    dom: { isConnected: true },
    dispatch: (tr: Parameters<EditorState["update"]>[0]) => {
      state = state.update(tr).state
    },
  } as unknown as EditorView
  return { view, getState: () => state }
}

describe("AC3 clean-cancel: a superseding generation cancels the prior one", () => {
  test("applyLiveDiffDecorations: a second apply drops gen-1 decorations and keeps only gen-2 (real field)", () => {
    const { view, getState } = makeStubView("a\nX\nb\nY\nc")

    applyLiveDiffDecorations(view, { addedLines: [{ startLine: 1, endLine: 2 }], replacedLines: [], removals: [] })
    expect(hasDecoClassAt(getState(), getState().doc.line(2).from, "cm-line-added")).toBe(true)

    applyLiveDiffDecorations(view, { addedLines: [{ startLine: 3, endLine: 4 }], replacedLines: [], removals: [] })
    expect(hasDecoClassAt(getState(), getState().doc.line(2).from, "cm-line-added")).toBe(false)
    expect(hasDecoClassAt(getState(), getState().doc.line(4).from, "cm-line-added")).toBe(true)
    expect(specClasses(getState())).toEqual(["cm-line-added"])

    cancelPriorLiveDiffClearTimers(Number.NaN) // drop the real default-duration timers this test armed
  })

  test("clearPriorLiveDiffEffect drops a stale replace(flash+underline)+collapse batch, keeping the new gen", () => {
    let state = State.create({ doc: "hello there\nkeep\ntail", extensions: [liveDiffDecorationsExtension()] })
    const g1 = buildLiveDiffDecorations(
      state,
      {
        addedLines: [],
        replacedLines: [{ startLine: 0, endLine: 1, oldLines: ["hello world"], newLines: ["hello there"] }],
        removals: [{ atLine: 2, lines: ["gone"] }],
      },
      { gen: 1, activeCollapses: 0 },
    )
    state = state.update({ effects: addLiveDiffEffect.of(g1.ranges) }).state
    expect(specClasses(state)).toContain("cm-live-diff-replaced-span")
    expect(countActiveCollapses(state.field(liveDiffField))).toBe(1)

    const g2 = buildLiveDiffDecorations(
      state,
      { addedLines: [{ startLine: 1, endLine: 2 }], replacedLines: [], removals: [] },
      { gen: 2, activeCollapses: 0 },
    )
    state = state.update({ effects: [clearPriorLiveDiffEffect.of(2), addLiveDiffEffect.of(g2.ranges)] }).state
    expect(specClasses(state)).not.toContain("cm-live-diff-replaced-span")
    expect(countActiveCollapses(state.field(liveDiffField))).toBe(0)
    expect(hasDecoClassAt(state, state.doc.line(2).from, "cm-line-added")).toBe(true)
  })

  test("regression control: a plain additive add WITHOUT clear-prior retains BOTH generations", () => {
    let state = State.create({ doc: "a\nX\nb\nY\nc", extensions: [liveDiffDecorationsExtension()] })
    const g1 = buildLiveDiffDecorations(state, { addedLines: [{ startLine: 1, endLine: 2 }], replacedLines: [], removals: [] }, { gen: 1, activeCollapses: 0 })
    const g2 = buildLiveDiffDecorations(state, { addedLines: [{ startLine: 3, endLine: 4 }], replacedLines: [], removals: [] }, { gen: 2, activeCollapses: 0 })
    state = state.update({ effects: addLiveDiffEffect.of(g1.ranges) }).state
    state = state.update({ effects: addLiveDiffEffect.of(g2.ranges) }).state
    expect(hasDecoClassAt(state, state.doc.line(2).from, "cm-line-added")).toBe(true)
    expect(hasDecoClassAt(state, state.doc.line(4).from, "cm-line-added")).toBe(true)
  })

  test("timer-level: a superseding generation cancels the prior generation's pending clear timers", async () => {
    const fired: number[] = []
    const t1 = scheduleLiveDiffClears(1, (p) => fired.push(p.gen), { collapseMs: 5, flashMs: 15 })
    registerLiveDiffClearTimers(1, t1)

    cancelPriorLiveDiffClearTimers(2)
    const t2 = scheduleLiveDiffClears(2, (p) => fired.push(p.gen), { collapseMs: 5, flashMs: 15 })
    registerLiveDiffClearTimers(2, t2)

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(fired).not.toContain(1)
    expect(fired).toContain(2)

    cancelPriorLiveDiffClearTimers(Number.NaN)
  })
})
