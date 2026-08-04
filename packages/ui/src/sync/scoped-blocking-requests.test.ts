import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"

import {
  areRequestArraysReferentiallyEqual,
  collectScopedBlockingRequests,
} from "./scoped-blocking-requests"

const session = (id: string, parentID?: string): Session => ({ id, parentID }) as Session

describe("scoped blocking requests", () => {
  test("collects requests for the current session subtree", () => {
    const rootRequest = { id: "perm_root" }
    const childRequest = { id: "perm_child" }
    const grandchildRequest = { id: "perm_grandchild" }
    const siblingRequest = { id: "perm_sibling" }
    const empty: Array<typeof rootRequest> = []

    const result = collectScopedBlockingRequests(
      [
        session("ses_root"),
        session("ses_child", "ses_root"),
        session("ses_grandchild", "ses_child"),
        session("ses_sibling"),
      ],
      {
        ses_root: [rootRequest],
        ses_child: [childRequest],
        ses_grandchild: [grandchildRequest],
        ses_sibling: [siblingRequest],
      },
      "ses_root",
      empty,
    )

    expect(result).toEqual([rootRequest, childRequest, grandchildRequest])
  })

  test("returns the provided empty array when no scoped requests exist", () => {
    const empty: Array<{ id: string }> = []

    expect(collectScopedBlockingRequests([session("ses_root")], {}, "ses_root", empty)).toBe(empty)
    expect(collectScopedBlockingRequests([session("ses_root")], {}, null, empty)).toBe(empty)
  })

  test("compares request arrays by item identity", () => {
    const first = { id: "perm_1" }
    const second = { id: "perm_2" }

    expect(areRequestArraysReferentiallyEqual([first, second], [first, second])).toBe(true)
    expect(areRequestArraysReferentiallyEqual([first, second], [second, first])).toBe(false)
    expect(areRequestArraysReferentiallyEqual([first], [{ id: "perm_1" }])).toBe(false)
  })

  test("self-heals: a question surfaces once its child session syncs into the store", () => {
    const question = { id: "que_child" }
    const empty: Array<typeof question> = []

    // The question.asked landed before the child session synced. The child is
    // absent from the session store, so membership cannot be resolved and the
    // question is intentionally NOT returned (QuestionRequest carries no parentID).
    const before = collectScopedBlockingRequests([session("ses_root")], { ses_child: [question] }, "ses_root", empty)
    expect(before).toBe(empty)

    // Once the child session (parentID -> root) arrives, the same question becomes
    // reachable through the subtree. The selector re-runs on the new session
    // reference, so the question self-heals into the result with no timing field.
    const after = collectScopedBlockingRequests(
      [session("ses_root"), session("ses_child", "ses_root")],
      { ses_child: [question] },
      "ses_root",
      empty,
    )
    expect(after).toEqual([question])
  })

  test("never returns an orphan question whose session is absent from the store", () => {
    const question = { id: "que_orphan" }
    const empty: Array<typeof question> = []

    const result = collectScopedBlockingRequests([session("ses_root")], { ses_orphan: [question] }, "ses_root", empty)
    expect(result).toBe(empty)
  })
})
