# AGENTS.md

This file defines how agents work with the documents in this directory.
It covers four folders only:

```
.
├── AGENTS.md
├── research-notes/   facts gathered before designing
├── proposed/         design proposals not yet fully implemented
├── implemented/      proposals that have been fully implemented
└── rejected/         proposals that will not be implemented
```

`docs/` at the repository root is reserved for project documentation. Do not
put research notes or proposals there.

---

## Language

- Every document in `research-notes/`, `proposed/`, `implemented/`, and
  `rejected/` **must be written in Indonesian**.
- Code, identifiers, method names, error messages, and quoted provider
  responses stay exactly as they are (do not translate them).
- This file (`AGENTS.md`) is written in English.

---

## File naming

### Proposals

Proposals are named:

```
YYYY-MM-DD_<proposal-name>.md
```

Example: `2026-11-21_namespace-kanonik-kiseki.md`.

`YYYY-MM-DD` is the date the proposal was created. It never changes: not when
the proposal is edited, renamed with `_partial-implemented`, or moved to
`implemented/` or `rejected/`.

A partially implemented proposal gets the `_partial-implemented` suffix (see
[Partial implementation](#partial-implementation)):

```
YYYY-MM-DD_<proposal-name>_partial-implemented.md
```

### Research notes

Research notes do not use a date in their file name:

```
<topic>.md
```

Example: `alchemy-provider.md`.

---

## Lifecycle

```
research-notes/ ──▶ proposed/ ──▶ implemented/
  (facts)            (design)  │
                               └──▶ rejected/
```

1. **Research first, when required.** If the target is an upstream or an
   external provider, a research note must exist before a proposal is written.
   For internal-only changes, a research note is not required.
2. **Propose.** Write the design in `proposed/`.
3. **Implement.** Build what the proposal describes.
4. **Move.** After implementation is complete and **all tests pass**, the agent
   may move the proposal from `proposed/` to `implemented/` without waiting for
   approval.
5. **Reject.** A proposal that will not be implemented is moved to `rejected/`
   with the reason for rejection. Do not delete it.

### Status

Every proposal carries a `Status` row in its metadata table. The value is
written in Indonesian, because the proposals themselves are written in
Indonesian. It follows the folder the proposal lives in and the
`_partial-implemented` suffix:

| Where the proposal is | Status value |
|---|---|
| `proposed/`, no suffix | `Diajukan untuk review` |
| `proposed/`, `_partial-implemented` suffix | `Diimplementasikan sebagian` |
| `implemented/` | `Diimplementasikan` |
| `rejected/` | `Ditolak` |

Update the value in the same step that moves or renames the file, so the table
never contradicts the folder. It is the only metadata row that changes on a
move; the date never does.

---

## `research-notes/`

Facts learned from data, gathered **before** implementation. A research note
answers "what is actually true?" so that the design is built on evidence, not
memory or assumption.

### Rules

- **Sources are official documentation and real measurements.** Never write a
  fact from memory. If the target is an upstream, measure it: make real calls to
  the real endpoint.
- **Facts only, no design decisions.** A note may state the implication of a
  fact, but architecture decisions belong in a proposal.
- **Label every fact with its confidence level:**

  | Label | Meaning |
  |---|---|
  | **TERUKUR** | Repeated, consistent results, exact figure |
  | **TERAMATI** | Clearly observed, but not repeated enough to be an exact figure |
  | **TIDAK KONSISTEN** | Measured several times with contradicting results; do not base decisions on it |

  Facts taken from documentation rather than measurement must be marked
  explicitly as coming from documentation (e.g. "dokumen").
- **Quote provider responses verbatim.** Error messages and payloads are copied
  exactly, so tests can use the real strings instead of invented ones.
- **Record gaps honestly.** If something could not be observed (e.g. a rate-limit
  response that could not be triggered), write that it is unknown. Do not fill
  the gap with a guess.
- **State the limits of the observation**: which account or tier, which date.
  Observations are not contracts; providers change behavior without notice.
- **Never write secrets.** API keys and tokens never appear in a note. Refer to
  them only by label or variable name.
- **Include reproduction steps** so that any measurement can be rerun.

### Editing

- **Edit, never append.** Update the relevant section in place. Do not add
  "update" or "addendum" sections at the end.
- **Re-measurements keep history.** If a new measurement gives a different
  value, keep the old value and add the new one next to it, each marked with
  its date. Do not overwrite the old value.

---

## `proposed/`

Design proposals that have not been fully implemented yet.

### Format

A proposal is a proposal, not an implementation plan. It is written to
convince a reviewer, and must be understandable by an implementer who is not
the author. Use this structure:

1. Summary, including what the reviewer is asked to approve
2. Problem
3. Goals and non-goals
4. Proposal
5. Alternatives considered, each with the reason it was rejected
6. Preserved principles
7. Impact
8. Risks and mitigations
9. Validation
10. Open questions
11. Next steps

Do not include local paths, shell commands, line numbers, progress checklists,
session notes, or anything specific to one person or one machine. Refer to
other documents by title, not by file path. Facts from a research note are
summarized in the proposal, not copied wholesale.

The only exception is the implementation status section of a partially
implemented proposal, which lists the files changed (see below).

### Editing

- **Edit, never append.** If a proposal exists and its design turns out to be
  wrong, at any point (including during implementation), rewrite the affected
  sections in place so the document always describes the current design.
- Do not add sections such as "Revision", "Implementation notes", "Follow-up",
  or "Correction" below the original content.
- Do not create a separate follow-up proposal to patch a proposal that is still
  in `proposed/`. Edit the original.
- Version history lives in version control, not in the document.

### Partial implementation

When only part of a proposal has been implemented:

1. **Rename** the file by adding the `_partial-implemented` suffix, e.g.
   `2026-11-21_namespace-kanonik-kiseki.md` →
   `2026-11-21_namespace-kanonik-kiseki_partial-implemented.md`.
   The file stays in `proposed/`.
2. **Add an implementation status section** (in Indonesian) at the top of the
   document, directly below the metadata table, stating:
   - which parts of the proposal have been implemented;
   - which files were changed during the implementation.
3. **Keep the section current.** As more work is done, edit this section in
   place; do not append new entries below old ones.
4. **When the rest is implemented** and all tests pass:
   - remove the implementation status section;
   - rename the file back to its original name (drop `_partial-implemented`);
   - move it to `implemented/`.

---

## `implemented/`

Proposals whose implementation is complete and whose tests all pass.

- Do not change the design described in a document here.
- If an implemented design needs to change, **write a new proposal in
  `proposed/`**. The new proposal refers to the implemented one by title.

---

## `rejected/`

Proposals that will not be implemented. Move them here from `proposed/`
instead of deleting them.

- A rejected proposal **must state why it was rejected**. Add a rejection
  section (in Indonesian) at the top of the document, directly below the
  metadata table, and set the status in the metadata table to `Ditolak` (see
  [Status](#status)).
