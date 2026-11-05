import { describe, expect, it } from "vitest"

// ── P3 automation policy (pure functions, no DB / network) ──
// Contract: MIN=15 / MAX=10080 minutes; normalizeSyncIntervalMinutes accepts
// in-range whole minutes and REJECTS fractional / NaN / Infinity / out-of-range
// values; computeNextSyncAt adds whole minutes without mutating `from`.
// Production also exports isScheduleDue — covered below as a dependency-free helper.

import {
  MIN_SYNC_INTERVAL_MINUTES,
  MAX_SYNC_INTERVAL_MINUTES,
  normalizeSyncIntervalMinutes,
  computeNextSyncAt,
  isScheduleDue,
  type ScheduleDueView,
} from "@/services/automation/policy"

describe("sync interval bounds", () => {
  it("exports the documented min (15m) and max (7 days / 10_080m)", () => {
    expect(MIN_SYNC_INTERVAL_MINUTES).toBe(15)
    expect(MAX_SYNC_INTERVAL_MINUTES).toBe(10_080)
  })
})

describe("normalizeSyncIntervalMinutes", () => {
  it("accepts the minimum and maximum bounds unchanged", () => {
    expect(normalizeSyncIntervalMinutes(15)).toBe(15)
    expect(normalizeSyncIntervalMinutes(10_080)).toBe(10_080)
  })

  it("accepts in-range whole-minute values unchanged", () => {
    expect(normalizeSyncIntervalMinutes(60)).toBe(60)
    expect(normalizeSyncIntervalMinutes(10_000)).toBe(10_000)
  })

  it.each([14, 5, 0, -30])("rejects out-of-range value %i below the minimum", (value) => {
    expect(() => normalizeSyncIntervalMinutes(value)).toThrow(
      /between 15 and 10080 minutes/,
    )
  })

  it.each([10_081, 20_000, 1_000_000])("rejects out-of-range value %i above the maximum", (value) => {
    expect(() => normalizeSyncIntervalMinutes(value)).toThrow(
      /between 15 and 10080 minutes/,
    )
  })

  it.each([15.5, 60.75, 10_080.0001])("rejects fractional interval %d", (value) => {
    expect(() => normalizeSyncIntervalMinutes(value)).toThrow(/whole number of minutes/)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite input %s",
    (value) => {
      expect(() => normalizeSyncIntervalMinutes(value)).toThrow(/finite number of minutes/)
    },
  )
})

describe("computeNextSyncAt", () => {
  it("adds the interval in minutes to the reference date", () => {
    const from = new Date("2026-01-01T00:00:00.000Z")
    const next = computeNextSyncAt(from, 60)
    expect(next.getTime()).toBe(from.getTime() + 60 * 60_000)
  })

  it("supports the minimum (15m) and maximum (7 days) intervals", () => {
    const from = new Date("2026-03-01T12:00:00.000Z")
    expect(computeNextSyncAt(from, 15).getTime()).toBe(from.getTime() + 15 * 60_000)
    expect(computeNextSyncAt(from, 10_080).getTime()).toBe(from.getTime() + 10_080 * 60_000)
  })

  it("does not mutate the input date and returns a fresh instance", () => {
    const from = new Date("2026-05-05T05:05:05.000Z")
    const marker = from.getTime()

    const next = computeNextSyncAt(from, 30)

    expect(from.getTime()).toBe(marker)
    expect(next).not.toBe(from)
    expect(next.getTime()).toBe(marker + 30 * 60_000)
  })

  it("rejects an invalid interval and an invalid `from` date", () => {
    const from = new Date("2026-01-01T00:00:00.000Z")
    expect(() => computeNextSyncAt(from, 0)).toThrow(/between 15 and 10080 minutes/)
    expect(() => computeNextSyncAt(from, 15.5)).toThrow(/whole number of minutes/)
    expect(() => computeNextSyncAt(from, Number.NaN)).toThrow(/finite number of minutes/)
    expect(() => computeNextSyncAt(new Date(Number.NaN), 60)).toThrow(/valid Date/)
  })
})

describe("isScheduleDue", () => {
  const now = new Date("2026-01-01T12:00:00.000Z")
  const past = new Date("2026-01-01T11:00:00.000Z")
  const future = new Date("2026-01-01T13:00:00.000Z")

  function view(overrides: Partial<ScheduleDueView>): ScheduleDueView {
    return {
      enabled: true,
      nextSyncAt: past,
      leaseExpiresAt: null,
      ...overrides,
    }
  }

  it("is due when enabled, past-due and unleased", () => {
    expect(isScheduleDue(view({}), now)).toBe(true)
  })

  it("is not due when disabled", () => {
    expect(isScheduleDue(view({ enabled: false }), now)).toBe(false)
  })

  it("is not due when nextSyncAt is missing", () => {
    expect(isScheduleDue(view({ nextSyncAt: null }), now)).toBe(false)
  })

  it("is not due while nextSyncAt is in the future", () => {
    expect(isScheduleDue(view({ nextSyncAt: future }), now)).toBe(false)
  })

  it("is due when nextSyncAt is exactly now (boundary)", () => {
    expect(isScheduleDue(view({ nextSyncAt: now }), now)).toBe(true)
  })

  it("is not due while a worker holds a still-valid lease", () => {
    expect(isScheduleDue(view({ leaseExpiresAt: future }), now)).toBe(false)
  })

  it("is due again once the lease has expired", () => {
    expect(isScheduleDue(view({ leaseExpiresAt: past }), now)).toBe(true)
  })
})