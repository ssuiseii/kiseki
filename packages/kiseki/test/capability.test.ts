import { describe, expect, test } from "bun:test"
import { RuntimeNotes } from "upstream-core"
import { candidatesFor, notesExclude, toView } from "../src/capability"
import { fakeAdapter } from "./helpers"

/**
 * Static capability matrix + pre-flight (design.md §8).
 *
 * Pre-flight is the one place the proxy can reject an item for free, so these
 * tests pin both directions: a miss must reject, and a hit must NOT reject — a
 * false negative here would make a working method unreachable.
 */

describe("candidatesFor (§8.2)", () => {
  const alchemy = fakeAdapter({ name: "alchemy", methods: ["eth_*", "trace_*"], archive: true })
  const ankr = fakeAdapter({ name: "ankr", methods: ["eth_*"], archive: false })

  test("returns every upstream whose methods cover the call", () => {
    const notes = new RuntimeNotes()
    const candidates = candidatesFor([alchemy.view, ankr.view], ["eth_call"], false, notes)
    expect(candidates.map((upstream) => upstream.name)).toEqual(["alchemy", "ankr"])
  })

  test("a trace method narrows to the trace-capable upstream", () => {
    const notes = new RuntimeNotes()
    const candidates = candidatesFor([alchemy.view, ankr.view], ["trace_block"], false, notes)
    expect(candidates.map((upstream) => upstream.name)).toEqual(["alchemy"])
  })

  test("needsArchive removes non-archive upstreams", () => {
    const notes = new RuntimeNotes()
    const candidates = candidatesFor([alchemy.view, ankr.view], ["eth_call"], true, notes)
    expect(candidates.map((upstream) => upstream.name)).toEqual(["alchemy"])
  })

  test("an empty set is the only pre-flight rejection", () => {
    const notes = new RuntimeNotes()
    expect(candidatesFor([alchemy.view, ankr.view], ["debug_traceCall"], false, notes)).toEqual([])
  })

  test("a runtime note removes the upstream without touching config", () => {
    const notes = new RuntimeNotes()
    notes.note("alchemy", "method", "trace_block")
    const candidates = candidatesFor([alchemy.view, ankr.view], ["trace_block"], false, notes)
    expect(candidates).toEqual([])
  })

  test("an archive note removes an upstream for historical calls only", () => {
    const notes = new RuntimeNotes()
    notes.note("alchemy", "archive")

    const historical = candidatesFor([alchemy.view], ["eth_call"], true, notes)
    expect(historical).toEqual([])

    // The same upstream is still fine for a latest query: the note is about a
    // capability dimension, not about the instance being broken (§8.3).
    const recent = candidatesFor([alchemy.view], ["eth_call"], false, notes)
    expect(recent.map((upstream) => upstream.name)).toEqual(["alchemy"])
  })
})

describe("notesExclude", () => {
  test("a method note excludes only that exact method", () => {
    const notes = new RuntimeNotes()
    notes.note("a", "method", "trace_block")
    expect(notesExclude(notes, "a", ["trace_block"], false)).toBe(true)
    expect(notesExclude(notes, "a", ["trace_transaction"], false)).toBe(false)
    // Another instance is unaffected.
    expect(notesExclude(notes, "b", ["trace_block"], false)).toBe(false)
  })

  test("an archive note excludes historical needs only", () => {
    const notes = new RuntimeNotes()
    notes.note("a", "archive")
    expect(notesExclude(notes, "a", ["eth_call"], true)).toBe(true)
    expect(notesExclude(notes, "a", ["eth_call"], false)).toBe(false)
  })

  test("any one noted method in the set excludes the upstream", () => {
    const notes = new RuntimeNotes()
    notes.note("a", "method", "trace_block")
    expect(notesExclude(notes, "a", ["eth_call", "trace_block"], false)).toBe(true)
  })
})

describe("toView", () => {
  test("copies the instance identity and snapshots the capability", () => {
    const fake = fakeAdapter({ name: "alchemy-ethereum", provider: "alchemy", methods: ["eth_*"] })
    const view = toView({
      config: { name: "alchemy-ethereum", provider: "alchemy" },
      adapter: fake.adapter,
    })
    expect(view.name).toBe("alchemy-ethereum")
    expect(view.provider).toBe("alchemy")
    expect(view.capability).toEqual({ methods: ["eth_*"], archive: true })
    expect(view.adapter).toBe(fake.adapter)
  })
})
