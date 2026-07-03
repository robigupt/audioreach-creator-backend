<!--
 Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
 SPDX-License-Identifier: BSD-3-Clause
-->

# SPF Module Definition Query Service — Overlay Pattern Refactor Requirements

**Related documents:**
- `docs/superpowers/specs/query-service-overlay-pattern.md` — governing pattern (target shape)
- `docs/superpowers/specs/spf-module-definition-query-lld.md` — original LLD, §5.4 flags known issues in the current implementation
- Target file: `packages/infrastructure/persistence/src/persistence-typeorm-sqllite/queries/spf-module-definition/db-spf-module-definition-query-service.ts`

## Background

`DbSpfModuleDefinitionQueryService` already batches overlay queries across a list (O(1) DB calls, not O(N)) but interleaves DB-query, overlay, and mapping logic inside a few large private methods (`loadSummaryReadModels`, `overlayDefinitionTree`, `assembleFullDetails`). The overlay pattern doc prescribes three independent layers per aggregate/sub-tree — DB Query, Overlay (pure, no DB), Mapping (pure, no DB, no overlay) — so that a schema change, a merge-rule change, and a read-model shape change each touch exactly one layer.

This is a structural refactor: it changes how the code is organized, not what it returns.

## Functional Requirements

**FR-1 — Behavior preservation.** Every public method's observable output (return values, `Result` success/failure shape, error codes) must be unchanged for every existing test case. This is a structural refactor only — no new fields, no changed filtering semantics, no changed error conditions.

**FR-2 — Three-layer separation, all public methods.** Restructure all public methods — `getModuleDefinitionSystemId`, `getDefinition`, `getParameterDefinition`, `getAllSpfModuleDefinitionSummaries`, `getSpfModuleDefinitionSummary`, `getCustomModuleMetadata`, `getCustomModuleMetadataBySystemIds`, `queryParameterDefinitions` — so each is composed of:
- **Layer 1 (DB Query)** — private helper(s) that only build/run TypeORM queries and return raw row types.
- **Layer 2 (Overlay)** — private helper(s) that take rows + `EditActionRow[]` and return overlaid raw row types. No DB access. Never call `findActiveSession`/`getEditActionsBy*` internally — those are always resolved once at the public-method level and passed down as parameters.
- **Layer 3 (Mapping)** — private helper(s) that take only overlaid row types and return read-model types. No DB access, no `actions` parameter, no conditional logic based on session state.

Where a method already has a discrete piece of this (e.g., `toCustomModuleMetadataReadModel` is already a pure Layer-3 mapper), reuse it rather than duplicating.

**FR-3 — Session/actions threading.** `findActiveSession` and the edit-actions fetch (`getEditActionsByTable`/`getEditActionsByAggregateId`) are each called at most once per public method invocation, never inside an overlay or mapping helper.

**FR-4 — `loadOverlaidDefinitionRows` fetch strategy — AMENDED, superseded post-implementation.** ~~The existing O(1)-queries-per-list-regardless-of-module-count behavior... must be preserved through the refactor.~~ Superseded: `loadOverlaidDefinitionRows` now issues one `getEditActionsByAggregateId` call per module in the requested set (O(N) queries), replacing the prior 6 fixed `getEditActionsByTable` calls (O(1) queries, but session-wide over-fetch discarded per module after bucketing by `aggregateId`). Rationale: for small N (get-by-id, small lists) this eliminates the over-fetch entirely, at the cost of the O(1) ceiling for large N. See design doc §7 for the full trade-off writeup. The old regression test (`query-count regression — batched overlay stays O(1) as module count grows`) was replaced with `aggregate-scoped overlay — one getEditActionsByAggregateId call per module`, asserting the call count equals the module count. `loadParameterDefinitionsForModules` is unaffected — it still uses table-scoped `getEditActionsByTable` for the parameter table; this amendment is scoped to `loadOverlaidDefinitionRows` only.

**FR-5 — No test changes required for behavior.** Because FR-1 holds, the existing integration test file (`db-spf-module-definition-query-service.spec.ts`) should pass without modification. Tests may be added (see Out of Scope) but existing assertions must not need to change to accommodate the refactor.

## Non-Functional / Constraints

- No changes to `@arc/core` read-model or port interfaces (`spf-module-definition-read-model.ts`, `SpfModuleDefinitionQueryService`) — this refactor is confined to the persistence-layer implementation file.
- No changes to `edit_actions` schema, `EditActionsQueryService`, or `overlay-merge.ts`/`overlay-utils.ts` helpers.
- No adoption of the future `Overlaid<T>` / `pendingChangeStatus` / `diffEntity` shapes from §4 of the pattern doc — the future design doc (`edit-crud/overall-design.md`) it depends on does not exist in the repo yet. Overlay helpers continue to return plain row arrays (`T[]`), not `Overlaid<T>[]`.

## Out of Scope (deferred, tracked separately — not addressed by this refactor)

- LLD §5.4 issue #3 (`queryParameterDefinitions` should be `private`) — deferred, to be revisited later.
- LLD §5.4 issue #4 (misleading "separate aggregate" comment) — deferred, to be revisited later.
- Adding test coverage for `getModuleDefinitionSystemId` and `getParameterDefinition`/`queryParameterDefinitions` — noted as a gap, to be addressed later, not part of this refactor.
- Any LLD §5.4 issues already fixed in current code (paramSystemIds filter bug, double `findActiveSession`) — no action needed, confirmed already resolved.

## Open Questions

None outstanding — scope confirmed by user.
