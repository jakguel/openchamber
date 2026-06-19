import { describe, expect, test } from "bun:test";
import { collectVisibleSessionIdsForBlockingRequests } from "../blockingRequests";

describe("collectVisibleSessionIdsForBlockingRequests", () => {
    test("returns empty array when currentSessionId is null", () => {
        const result = collectVisibleSessionIdsForBlockingRequests([], null);
        expect(result).toEqual([]);
    });

    test("returns [currentSessionId] when sessions is empty", () => {
        const result = collectVisibleSessionIdsForBlockingRequests([], "parent-1");
        expect(result).toEqual(["parent-1"]);
    });

    test("returns [currentSessionId] when sessions is undefined", () => {
        const result = collectVisibleSessionIdsForBlockingRequests(undefined, "parent-1");
        expect(result).toEqual(["parent-1"]);
    });

    test("includes currentSessionId and its direct child even when currentSessionId is NOT in sessions array", () => {
        // Regression test for the early-return race:
        // Before the fix, `if (!current) return [currentSessionId]` would skip BFS entirely,
        // returning only ["parent-1"] and missing the child session.
        const sessions = [
            { id: "child-1", parentID: "parent-1" },
        ];
        const result = collectVisibleSessionIdsForBlockingRequests(sessions, "parent-1");
        expect(result).toContain("parent-1");
        expect(result).toContain("child-1");
        expect(result).toHaveLength(2);
    });

    test("includes transitive children when currentSessionId is NOT in sessions array", () => {
        const sessions = [
            { id: "child-1", parentID: "parent-1" },
            { id: "grandchild-1", parentID: "child-1" },
        ];
        const result = collectVisibleSessionIdsForBlockingRequests(sessions, "parent-1");
        expect(result).toContain("parent-1");
        expect(result).toContain("child-1");
        expect(result).toContain("grandchild-1");
        expect(result).toHaveLength(3);
    });

    test("includes currentSessionId and its children when currentSessionId IS in sessions array", () => {
        const sessions = [
            { id: "parent-1" },
            { id: "child-1", parentID: "parent-1" },
            { id: "child-2", parentID: "parent-1" },
            { id: "unrelated", parentID: "other-parent" },
        ];
        const result = collectVisibleSessionIdsForBlockingRequests(sessions, "parent-1");
        expect(result).toContain("parent-1");
        expect(result).toContain("child-1");
        expect(result).toContain("child-2");
        expect(result).not.toContain("unrelated");
        expect(result).toHaveLength(3);
    });

    test("does not include sessions from unrelated subtrees", () => {
        const sessions = [
            { id: "child-1", parentID: "parent-1" },
            { id: "unrelated-child", parentID: "other-parent" },
        ];
        const result = collectVisibleSessionIdsForBlockingRequests(sessions, "parent-1");
        expect(result).not.toContain("unrelated-child");
    });

    test("does not produce duplicates or infinite loops with circular-like data", () => {
        // Defensive: even if data is malformed, visited set prevents infinite loop
        const sessions = [
            { id: "child-1", parentID: "parent-1" },
            { id: "child-2", parentID: "child-1" },
        ];
        const result = collectVisibleSessionIdsForBlockingRequests(sessions, "parent-1");
        const unique = new Set(result);
        expect(unique.size).toBe(result.length);
    });
});
