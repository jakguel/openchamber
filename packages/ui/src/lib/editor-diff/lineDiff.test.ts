import { describe, expect, test } from "bun:test";
import {
  computeLineDiff,
  LINE_SIMILARITY_REPLACE_THRESHOLD,
  type LineDiffOp,
} from "./lineDiff";

// These tests exercise the real @pierre/diffs line diff + real word-alt span
// joiner. No mocks: every assertion pins a value that a specific classifier or
// offset bug would flip.

describe("computeLineDiff", () => {
  test("identical input yields no ops", () => {
    expect(computeLineDiff("a\nb\nc\n", "a\nb\nc\n")).toEqual([]);
  });

  test("exposes the replace-classification threshold as 0.5", () => {
    expect(LINE_SIMILARITY_REPLACE_THRESHOLD).toBe(0.5);
  });

  test("all-add: pure insertion into an empty file", () => {
    expect(computeLineDiff("", "x\ny\nz\n")).toEqual([
      { type: "add", newStart: 1, newLines: ["x", "y", "z"] },
    ]);
  });

  test("all-remove: pure deletion to an empty file", () => {
    expect(computeLineDiff("x\ny\nz\n", "")).toEqual([
      { type: "remove", oldStart: 1, oldLines: ["x", "y", "z"] },
    ]);
  });

  test("in-place replace when similarity >= threshold, with within-line span on the new line", () => {
    const ops = computeLineDiff("hello world\n", "hello there\n");
    expect(ops).toEqual([
      {
        type: "replace",
        oldStart: 1,
        newStart: 1,
        oldLines: ["hello world"],
        newLines: ["hello there"],
        // "world" -> "there": the changed span covers offsets 6..11 of the NEW line.
        withinLine: [{ newLineOffset: 0, spans: [{ from: 6, to: 11 }] }],
      },
    ]);
  });

  test("low-similarity delete+insert stays separate remove + add (not replace)", () => {
    const ops = computeLineDiff("aaaaaaaaaa\n", "zzzzzzzzzz\n");
    expect(ops).toEqual([
      { type: "remove", oldStart: 1, oldLines: ["aaaaaaaaaa"] },
      { type: "add", newStart: 1, newLines: ["zzzzzzzzzz"] },
    ]);
    // Guard: it must NOT collapse into a replace.
    expect(ops.some((op) => op.type === "replace")).toBe(false);
  });

  test("multi-line simultaneous: two non-adjacent replaces keep correct 1-based line numbers", () => {
    const ops = computeLineDiff(
      "hello world\ncommon\ngoodbye moon\n",
      "hello there\ncommon\ngoodbye sun\n",
    );
    expect(ops).toEqual([
      {
        type: "replace",
        oldStart: 1,
        newStart: 1,
        oldLines: ["hello world"],
        newLines: ["hello there"],
        withinLine: [{ newLineOffset: 0, spans: [{ from: 6, to: 11 }] }],
      },
      {
        type: "replace",
        oldStart: 3,
        newStart: 3,
        oldLines: ["goodbye moon"],
        newLines: ["goodbye sun"],
        withinLine: [{ newLineOffset: 0, spans: [{ from: 8, to: 11 }] }],
      },
    ]);
  });

  test("adjacent multi-line replace collapses into one op with per-new-line within spans", () => {
    const ops = computeLineDiff("apple pie\nbanana split\n", "apple tart\nbanana boat\n");
    expect(ops).toEqual([
      {
        type: "replace",
        oldStart: 1,
        newStart: 1,
        oldLines: ["apple pie", "banana split"],
        newLines: ["apple tart", "banana boat"],
        withinLine: [
          { newLineOffset: 0, spans: [{ from: 6, to: 10 }] },
          { newLineOffset: 1, spans: [{ from: 7, to: 11 }] },
        ],
      },
    ]);
  });

  test("within-line word-alt produces multiple spans, leaving unchanged words neutral", () => {
    const ops = computeLineDiff("the quick brown fox\n", "the slow brown cat\n");
    expect(ops.length).toBe(1);
    const op = ops[0];
    expect(op.type).toBe("replace");
    if (op.type !== "replace") throw new Error("expected replace");
    // "quick" -> "slow" and "fox" -> "cat" change; "the " and " brown " stay neutral.
    expect(op.withinLine).toEqual([
      { newLineOffset: 0, spans: [{ from: 4, to: 9 }, { from: 15, to: 18 }] },
    ]);
    // Every span indexes the NEW line ("the slow brown cat"), never the old line.
    const newLine = op.newLines[0];
    expect(newLine.slice(15, 18)).toBe("cat");
    expect(newLine.length).toBe(18);
  });

  describe("replace-classification threshold boundary", () => {
    // sim("aaaaaaaaaa", "aaaaaZZZZZ") = 1 - 5/10 = 0.5  -> exactly at threshold
    test("similarity exactly at threshold classifies as replace (>= is inclusive)", () => {
      const ops = computeLineDiff("aaaaaaaaaa\n", "aaaaaZZZZZ\n");
      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe("replace");
    });

    // sim("aaaaaaaaaa", "aaaaZZZZZZ") = 1 - 6/10 = 0.4  -> just below threshold
    test("similarity just below threshold classifies as remove + add", () => {
      const ops = computeLineDiff("aaaaaaaaaa\n", "aaaaZZZZZZ\n");
      expect(ops).toEqual([
        { type: "remove", oldStart: 1, oldLines: ["aaaaaaaaaa"] },
        { type: "add", newStart: 1, newLines: ["aaaaZZZZZZ"] },
      ]);
    });
  });

  test("unpaired deletion tail: extra deleted line becomes its own remove op", () => {
    // Change block: 2 deletions + 1 addition, low similarity.
    const ops = computeLineDiff("aaa\nbbb\n", "zzz\n");
    expect(ops).toEqual([
      { type: "remove", oldStart: 1, oldLines: ["aaa"] },
      { type: "add", newStart: 1, newLines: ["zzz"] },
      { type: "remove", oldStart: 2, oldLines: ["bbb"] },
    ]);
  });

  test("unpaired addition tail: extra added line becomes its own add op after a replace", () => {
    // Change block: 1 deletion + 2 additions, first pair is a high-similarity replace.
    const ops = computeLineDiff("hello world\n", "hello there\nbrand new\n");
    expect(ops).toEqual([
      {
        type: "replace",
        oldStart: 1,
        newStart: 1,
        oldLines: ["hello world"],
        newLines: ["hello there"],
        withinLine: [{ newLineOffset: 0, spans: [{ from: 6, to: 11 }] }],
      },
      { type: "add", newStart: 2, newLines: ["brand new"] },
    ]);
  });

  test("returns a plain JSON-serializable structure (no DOM / editor objects leak in)", () => {
    const ops: LineDiffOp[] = computeLineDiff("a\n", "b\n");
    // Round-tripping through JSON proves the ops are plain data: a class
    // instance, function, or DOM node would either throw or not survive.
    expect(JSON.parse(JSON.stringify(ops))).toEqual(ops);
  });
});
