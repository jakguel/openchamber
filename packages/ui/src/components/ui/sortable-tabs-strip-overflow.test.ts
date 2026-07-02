import { describe, expect, test } from "bun:test"

import { computeRailOverflow, SCROLL_RAIL_WIDTH } from "./sortable-tabs-strip-overflow"

describe("computeRailOverflow", () => {
  const railWidth = SCROLL_RAIL_WIDTH

  test("returns false when content fits the container", () => {
    expect(
      computeRailOverflow({ scrollWidth: 300, clientWidth: 400, railMounted: false, railWidth }),
    ).toBe(false)
  })

  test("returns true when content overflows the container", () => {
    expect(
      computeRailOverflow({ scrollWidth: 500, clientWidth: 400, railMounted: false, railWidth }),
    ).toBe(true)
  })

  test("boundary decision is stable whether the rail is mounted or not", () => {
    // Full container width is 400; content (360) fits the full width but would
    // overflow the rail-reduced width (400 - railWidth). Feeding both the
    // rail-absent and rail-mounted clientWidth at the same content must yield
    // the SAME result, so mounting the rail cannot flip the mount decision.
    const fullWidth = 400
    const content = 360

    const railAbsent = computeRailOverflow({
      scrollWidth: content,
      clientWidth: fullWidth,
      railMounted: false,
      railWidth,
    })
    const railMounted = computeRailOverflow({
      scrollWidth: content,
      clientWidth: fullWidth - railWidth,
      railMounted: true,
      railWidth,
    })

    expect(railAbsent).toBe(railMounted)
  })

  test("genuine overflow stays overflow whether the rail is mounted or not", () => {
    const fullWidth = 400
    const content = 600

    const railAbsent = computeRailOverflow({
      scrollWidth: content,
      clientWidth: fullWidth,
      railMounted: false,
      railWidth,
    })
    const railMounted = computeRailOverflow({
      scrollWidth: content,
      clientWidth: fullWidth - railWidth,
      railMounted: true,
      railWidth,
    })

    expect(railAbsent).toBe(true)
    expect(railMounted).toBe(true)
  })
})
