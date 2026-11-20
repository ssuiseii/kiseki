/**
 * Static capability matrix + pre-flight (design.md §8, implementation.md §4
 * tahap A).
 *
 * The rule that makes routing correct is narrow and absolute (design.md §4.2
 * invariant 1): an item is only ever sent to an upstream whose configured
 * capability says it can serve it. Everything here answers one question — "which
 * upstreams may this item go to?" — from static config plus the runtime notes
 * that *correct* that config when reality disagrees (#34–35).
 */

import {
  capabilityCovers,
  type Capability,
  type RuntimeNotes,
  type UpstreamAdapter,
} from "upstream-core"

/** One upstream instance of a chain, as the router sees it. */
export type UpstreamView = {
  /** Instance name from config (unique globally, §15.1 rule 3). */
  name: string
  provider: string
  adapter: UpstreamAdapter
  capability: Capability
}

/** Build the router's view of one built upstream. */
export const toView = (upstream: {
  config: { name: string; provider: string }
  adapter: UpstreamAdapter
}): UpstreamView => ({
  name: upstream.config.name,
  provider: upstream.config.provider,
  adapter: upstream.adapter,
  capability: upstream.adapter.capability(),
})

/**
 * Has a runtime note proven that this instance cannot serve the group?
 *
 * A note is per instance and apikey-independent (design.md §8.3): it records what
 * the *upstream* turned out to be, so one mismatch corrects every future request
 * for that method/archive dimension.
 */
export const notesExclude = (
  notes: RuntimeNotes,
  instance: string,
  methods: readonly string[],
  needsArchive: boolean,
): boolean => {
  if (needsArchive && notes.isArchiveDisabled(instance)) return true
  return methods.some((method) => notes.hasMethodNote(instance, method))
}

/**
 * Pre-flight candidate set (design.md §8.2, implementation.md §4 tahap A):
 * every upstream of the chain whose static capability covers the item, minus the
 * ones a runtime note has already disproven.
 *
 * An empty set is the ONLY instant rejection: no quota is charged and no attempt
 * is made, so a method no upstream can serve costs nothing.
 */
export const candidatesFor = (
  upstreams: readonly UpstreamView[],
  methods: readonly string[],
  needsArchive: boolean,
  notes: RuntimeNotes,
): UpstreamView[] =>
  upstreams.filter(
    (upstream) =>
      capabilityCovers(upstream.capability, methods, needsArchive) &&
      !notesExclude(notes, upstream.name, methods, needsArchive),
  )
