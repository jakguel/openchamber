import { describe, expect, test } from "bun:test"
import { ChangeSet, EditorSelection, EditorState } from "@codemirror/state"

import {
  buildExternalUpdateTransaction,
  computeLineDiff,
  EXTERNAL_UPDATE_REPLACE_SIMILARITY,
} from "./codeMirrorExternalUpdate"

const docOf = (text: string) => EditorState.create({ doc: text }).doc
const cursorAt = (pos: number) => EditorSelection.create([EditorSelection.cursor(pos)])

const changedSpan = (changes: ChangeSet) => {
  let minFrom = Number.POSITIVE_INFINITY
  let maxTo = 0
  changes.iterChanges((fromA, toA) => {
    minFrom = Math.min(minFrom, fromA)
    maxTo = Math.max(maxTo, toA)
  })
  return { minFrom, maxTo }
}

const spansWholeDoc = (changes: ChangeSet, oldLength: number) => {
  const { minFrom, maxTo } = changedSpan(changes)
  return minFrom === 0 && maxTo === oldLength
}

describe("computeLineDiff", () => {
  test("pure insertion emits a single add op anchored at the new line", () => {
    const ops = computeLineDiff("a\nb", "a\nX\nb")
    expect(ops).toEqual([{ type: "add", newStart: 1, newLines: ["X"] }])
  })

  test("pure deletion emits a single remove op anchored at the old line", () => {
    const ops = computeLineDiff("a\nX\nb", "a\nb")
    expect(ops).toEqual([{ type: "remove", oldStart: 1, oldLines: ["X"] }])
  })

  test("high-similarity edit is classified as an in-place replace", () => {
    const ops = computeLineDiff("hello world", "hello there")
    expect(ops).toHaveLength(1)
    expect(ops[0].type).toBe("replace")
    if (ops[0].type === "replace") {
      expect(ops[0].oldStart).toBe(0)
      expect(ops[0].newStart).toBe(0)
      expect(ops[0].oldLines).toEqual(["hello world"])
      expect(ops[0].newLines).toEqual(["hello there"])
    }
  })

  test("low-similarity change is a remove + add, not a replace", () => {
    const ops = computeLineDiff("aaaa", "zzzz zzzz zzzz")
    expect(ops.map((op) => op.type)).toEqual(["remove", "add"])
  })

  test("the replace-classification threshold is the documented 0.5", () => {
    expect(EXTERNAL_UPDATE_REPLACE_SIMILARITY).toBe(0.5)
  })
})

describe("buildExternalUpdateTransaction", () => {
  test("returns null when content is byte-identical (no dispatch)", () => {
    const result = buildExternalUpdateTransaction(docOf("x\ny"), "x\ny", cursorAt(0))
    expect(result).toBeNull()
  })

  test("a differing update yields a scoped per-change set, NOT a full-doc replace", () => {
    const oldDoc = docOf("a\nb\nc\nd")
    const next = "a\nB\nc\nd"
    const result = buildExternalUpdateTransaction(oldDoc, next, cursorAt(0))
    expect(result).not.toBeNull()
    if (!result) return

    expect(result.changes.apply(oldDoc).toString()).toBe(next)
    expect(spansWholeDoc(result.changes, oldDoc.length)).toBe(false)

    const { minFrom, maxTo } = changedSpan(result.changes)
    expect(minFrom).toBeGreaterThan(0)
    expect(maxTo).toBeLessThan(oldDoc.length)
  })

  test("caret below a removed line is preserved (a from:0,to:len replace would destroy this)", () => {
    const oldDoc = docOf("l0\nl1\nl2\nl3\nl4")
    const headInL3 = 10
    expect(oldDoc.lineAt(headInL3).text).toBe("l3")

    const result = buildExternalUpdateTransaction(oldDoc, "l0\nl2\nl3\nl4", cursorAt(headInL3))
    expect(result).not.toBeNull()
    if (!result?.selection) throw new Error("expected a mapped selection")

    expect(spansWholeDoc(result.changes, oldDoc.length)).toBe(false)

    const newDoc = result.changes.apply(oldDoc)
    const head = result.selection.main.head
    expect(head).toBe(headInL3 - 3)
    expect(newDoc.lineAt(head).text).toBe("l3")
  })

  test("caret inside a removed region snaps to the nearest surviving line start", () => {
    const oldDoc = docOf("a\nDEL\nb")
    const headInDeleted = 3
    expect(oldDoc.lineAt(headInDeleted).text).toBe("DEL")

    const result = buildExternalUpdateTransaction(oldDoc, "a\nb", cursorAt(headInDeleted))
    expect(result).not.toBeNull()
    if (!result?.selection) throw new Error("expected a mapped selection")

    const newDoc = result.changes.apply(oldDoc)
    const head = result.selection.main.head
    expect(newDoc.lineAt(head).from).toBe(head)
    expect(newDoc.lineAt(head).text).toBe("b")
  })

  test("simultaneous edit + removal + append reconstructs the exact new content per-change", () => {
    const oldDoc = docOf("keep0\nedit1\nkeep2\ndrop3\nkeep4")
    const next = "keep0\nEDIT1\nkeep2\nkeep4\nappended"
    const result = buildExternalUpdateTransaction(oldDoc, next, cursorAt(0))
    expect(result).not.toBeNull()
    if (!result) return

    expect(result.changes.apply(oldDoc).toString()).toBe(next)
    expect(spansWholeDoc(result.changes, oldDoc.length)).toBe(false)
  })

  test("clearing a single-line doc reconstructs empty content without a fallback replace", () => {
    const oldDoc = docOf("a")
    const result = buildExternalUpdateTransaction(oldDoc, "", cursorAt(1))
    expect(result).not.toBeNull()
    if (!result) return

    expect(result.changes.apply(oldDoc).toString()).toBe("")
  })
})
