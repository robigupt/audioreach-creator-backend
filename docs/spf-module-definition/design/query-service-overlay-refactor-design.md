<!--
 Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
 SPDX-License-Identifier: BSD-3-Clause
-->

# SPF Module Definition Query Service — Overlay Pattern Refactor Design

Requirements: [../requirements/query-service-overlay-refactor-requirements.md](../requirements/query-service-overlay-refactor-requirements.md)

**Governing pattern:** `docs/superpowers/specs/query-service-overlay-pattern.md`
**Original LLD:** `docs/superpowers/specs/spf-module-definition-query-lld.md`
**Target file:** `packages/infrastructure/persistence/src/persistence-typeorm-sqllite/queries/spf-module-definition/db-spf-module-definition-query-service.ts`

## 1. Overview

This is a pure structural refactor. `DbSpfModuleDefinitionQueryService` already batches overlay queries across a list in O(1) DB calls, but its overlay and mapping logic are interleaved inside a few large tree-walking private methods (`overlayDefinitionTree`, `assembleFullDetails`, `toModuleInfoSummary`). This design splits those into the three independent layers the governing pattern doc prescribes — DB Query, Overlay, Mapping — with one table-scoped private method per layer per table, plus a thin composer per aggregate concern to avoid duplicating tree-assembly glue.

No public method signature, return type, or observable behavior changes (FR-1). No `@arc/core` port/read-model changes. No `edit_actions` schema or `OverlayMerge`/`EditActionsQueryService` changes.

## 2. Layer Inventory

### 2.1 Layer 1 — DB Query (unchanged)

These already exist and stay exactly as-is:
- `buildSummaryQueryBuilder(fileSystemId)` — the one JOIN query (root + processor + containerTypes + portGroups/ports + staticPorts/staticIntents + dynamicIntents)
- the single-row query in `getModuleDefinitionSystemId`
- the single-row query (step 1) in `getParameterDefinition`
- the `ModuleManagerData` queries in `getCustomModuleMetadata`, `getCustomModuleMetadataBySystemIds`, and the existence-check subquery inside `loadSummaryReadModels`
- the parameter-rows `IN` query inside `loadParameterDefinitionsForModules`

### 2.2 Layer 2 — Overlay (granular helpers, one per table)

One private method per table, including nested child tables — `overlayPorts`/`overlayStaticIntents` are their own top-level helpers rather than nested inline inside `overlayPortGroups`/`overlayStaticPorts`. Each filters `actions` internally by its own table constant — callers never pre-filter (doc §2.2 rule):

```typescript
private overlayModuleDefinitionRow(row: SpfModuleDefinitionRow, actions: EditActionRow[]): SpfModuleDefinitionRow | null
private overlayPortGroups(rows: DataPortGroupRow[], actions: EditActionRow[]): DataPortGroupRow[]
private overlayPorts(rows: DataPortDefinitionRow[], actions: EditActionRow[]): DataPortDefinitionRow[]
private overlayStaticPorts(rows: StaticControlPortRow[], actions: EditActionRow[]): StaticControlPortRow[]
private overlayStaticIntents(rows: StaticIntentDefinitionRow[], actions: EditActionRow[]): StaticIntentDefinitionRow[]
private overlayDynamicIntents(rows: DynamicIntentDefinitionRow[], actions: EditActionRow[]): DynamicIntentDefinitionRow[]
private overlayParameterDefs(rows: SpfModuleParameterDefinitionRow[], actions: EditActionRow[]): SpfModuleParameterDefinitionRow[]
```

Each is a thin wrapper: `overlayModuleDefinitionRow` delegates to `applyTableOverlay(row, actions, ENTITY_NAMES.SpfModuleDefinition)`; the rest delegate to `applyToCollection(rows, actions.filter(a => a.tableName === ENTITY_NAMES.X))`. Nesting (ports under port groups, static intents under static ports) is done by the composer (§2.4) calling both helpers and assigning the child result onto the parent's field — not inside `overlayPortGroups`/`overlayStaticPorts` themselves. These replace the inline `.filter(a => a.tableName === ...)` + `applyToCollection` calls currently spread across `overlayDefinitionTree`.

`overlayParameterDefs` remains the one helper genuinely shared across multiple public methods (`loadSummaryReadModels`, `getParameterDefinition`, `queryParameterDefinitions`, all via `loadParameterDefinitionsForModules`) — no different from the rest in this split, just worth noting since it's the multi-caller case that would matter if we'd gone with the narrower 4-helper split instead.

### 2.3 Layer 3 — Mapping (granular helpers, one per table)

One private method per table, pure row → read-model, no `actions` parameter, no session-derived conditionals. Mirrors the overlay split — `mapPorts`/`mapStaticIntents` are standalone, composed by the parent mapper rather than nested inline:

```typescript
private mapPortGroups(rows: DataPortGroupRow[]): DataPortGroupReadModel[]
private mapPorts(rows: DataPortDefinitionRow[]): DataPortDefinitionReadModel[]
private mapStaticPorts(rows: StaticControlPortRow[]): ControlPortDefinitionReadModel[]
private mapStaticIntents(rows: StaticIntentDefinitionRow[]): StaticIntentDefinitionReadModel[]
private mapDynamicIntents(rows: DynamicIntentDefinitionRow[]): DynamicIntentDefinitionReadModel[]
private mapParameterDefs(rows: SpfModuleParameterDefinitionRow[]): ParameterDefinitionReadModel[]   // renamed from toParameterDefinitionReadModel(row); now takes the array
private mapContainerTypes(links: ContainerTypeLinkRow[]): ContainerTypeSummaryReadModel[]           // extracted out of toModuleInfoSummary
```

`toCustomModuleMetadataReadModel` and `toParameterSummaryReadModel` already satisfy Layer-3 rules (pure, row-only input) and are kept unchanged.

### 2.4 Composers

Two thin composers replace today's tree-walkers, each calling only the granular helpers above and doing the parent/child assembly:

```typescript
private overlayModuleDefinitionTree(row: SpfModuleDefinitionRow, actions: EditActionRow[]): SpfModuleDefinitionRow {
  const overlaidDef = this.overlayModuleDefinitionRow(row, actions) ?? row;

  const overlaidPortGroups = this.overlayPortGroups(overlaidDef.dataPortGroups ?? [], actions)
    .map(g => ({...g, ports: this.overlayPorts(g.ports ?? [], actions)}));

  const overlaidStaticPorts = this.overlayStaticPorts(overlaidDef.staticPorts ?? [], actions)
    .map(p => ({...p, staticIntents: this.overlayStaticIntents(p.staticIntents ?? [], actions)}));

  return {
    ...overlaidDef,
    dataPortGroups: overlaidPortGroups,
    staticPorts: overlaidStaticPorts,
    dynamicIntents: this.overlayDynamicIntents(overlaidDef.dynamicIntents ?? [], actions),
  };
}

private mapModuleInfoSummary(overlaidRow: SpfModuleDefinitionRow): ModuleInfoSummaryReadModel {
  const portGroups = this.mapPortGroups(overlaidRow.dataPortGroups ?? []);
  const staticCtrlPorts = this.mapStaticPorts(overlaidRow.staticPorts ?? []);
  const dynamicIntents = this.mapDynamicIntents(overlaidRow.dynamicIntents ?? []);
  const containerTypeInfo = this.mapContainerTypes(overlaidRow.containerTypeLinks ?? []);

  return {
    pidFramework: 0, // no column on spf_module_definitions yet
    stackSize: overlaidRow.stackSize,
    containerTypeInfo,
    metaData: undefined, // no column yet
    reserved: undefined, // no column yet
    inputDataPortInfo: portGroups.find(g => g.portIoType === PORT_IO_TYPE.Input) ?? null,
    outputDataPortInfo: portGroups.find(g => g.portIoType === PORT_IO_TYPE.Output) ?? null,
    staticCtrlPorts,
    dynamicIntents,
    moduleTypeInfo: undefined, // no column yet
    mdfModuleType: undefined, // no column yet
  };
}
```

`mapPortGroups` itself calls `mapPorts` internally for each group's `ports` field (and `mapStaticPorts` calls `mapStaticIntents` likewise) — these two mapping composites nest one level below `mapModuleInfoSummary`, since a `DataPortGroupReadModel`'s `ports` field is part of its own shape, not a sibling concern the caller assembles separately (unlike the overlay side, where composing at the tree-composer level was necessary to plug the two independently-fetched-and-filtered `EditActionRow[]` slices in). Where mapping has no `actions` to thread, nesting one call inside another is just normal function composition.

`overlayModuleDefinitionTree` replaces `overlayDefinitionTree` (drops the `includeLeafDetails` flag — see §4, Behavior Note). `mapModuleInfoSummary` replaces `toModuleInfoSummary` + `assembleFullDetails` combined — `assembleFullDetails` is deleted; its three field-selection blocks become `mapPortGroups`/`mapStaticPorts`/`mapDynamicIntents`, already needed as standalone Layer-3 helpers.

## 3. Data Flow per Public Method

**`getAllSpfModuleDefinitionSummaries` / `getSpfModuleDefinitionSummary`** (both funnel through `loadSummaryReadModels`):

```
loadSummaryReadModels(qb, fileSystemId)
  L1: qb.getMany() → SpfModuleDefinitionRow[]
  L1: findActiveSession(fileSystemId) → session (once)
  concurrently:
    loadOverlaidDefinitionRows(rows, sessionId):
      L1: 6 getEditActionsByTable calls (concurrent) → grouped by aggregateId
      L2: for each row → overlayModuleDefinitionTree(row, actions)   // composer
    loadParameterDefinitionsForModules(moduleIds, sessionId):
      L1: param rows IN query + getEditActionsByTable
      L2: overlayParameterDefs(rows, actions)
      L3: mapParameterDefs(overlaid) → ParameterDefinitionReadModel[]
    ModuleManagerData existence query (unchanged)
  L3: for each row → assemble SpfModuleDefinitionSummaryReadModel using
    mapModuleInfoSummary(overlaidRow), toParameterSummaryReadModel(params), inline processorInfo field selection
```

**`getDefinition`** — unchanged: calls `buildSummaryQueryBuilder` + `loadSummaryReadModels`, finds the matching summary, converts via `summaryToDefinitionReadModel`. Requires no direct changes — it already benefits once `loadSummaryReadModels` is restructured underneath it.

**`getParameterDefinition`** — unchanged at the call-site level: single-row query (L1) → `loadParameterDefinitionsForModules` (L1/L2/L3, already granular after this refactor) → field-subset selection based on `includes` (L3, existing logic, untouched).

**`getCustomModuleMetadata` / `getCustomModuleMetadataBySystemIds`** — unchanged: L1 query → `toCustomModuleMetadataReadModel` (L3). No overlay involved (`module_manager_data` isn't session-editable).

**`getModuleDefinitionSystemId`** — unchanged: L1 only, no overlay/mapping.

**`queryParameterDefinitions`** — unchanged at the call-site level: thin wrapper around `loadParameterDefinitionsForModules` + local `paramSystemIds` filter.

## 4. Behavior Note — `includeLeafDetails` flag removal

Today's `overlayDefinitionTree(baseRow, actions, {includeLeafDetails})` conditionally skips overlaying `ports`/`staticIntents`/`dynamicIntents` when `includeLeafDetails` is `false`, used by `getDefinition`'s summary-mode branch. However, `loadOverlaidDefinitionRows` (the only current caller of `overlayDefinitionTree`) **always** passes `includeLeafDetails: true` — the summary read model has no summary/fullDetails toggle. `getDefinition` itself no longer calls `overlayDefinitionTree` directly; it goes through `loadSummaryReadModels`, which always resolves full detail, and derives its own summary/fullDetails split afterward in `summaryToDefinitionReadModel` (a pure field-selection step, not an overlay-skipping step).

Since `includeLeafDetails: false` is dead code on every live call path today, `overlayModuleDefinitionTree` drops the parameter — it always overlays every leaf table. This is a code-deletion of an unreachable branch, not a behavior change: no test exercises `includeLeafDetails: false`, and no current caller passes it. Per FR-1, this must be verified during implementation (grep for `includeLeafDetails` call sites before deleting) rather than assumed.

## 5. Testing

Per FR-1 and FR-5, the existing integration test file (`db-spf-module-definition-query-service.spec.ts`) must pass unmodified — no test assertions change. Per requirements' Out-of-Scope section, no new tests are added for `getModuleDefinitionSystemId` or `getParameterDefinition` in this refactor.

**Amendment (post-implementation):** `loadOverlaidDefinitionRows` was subsequently changed from table-scoped (`getEditActionsByTable`, 6 fixed queries regardless of module count) to aggregate-scoped (`getEditActionsByAggregateId`, one query per module) — see §7. This **reverses FR-4** — query count is now O(N), not O(1). The `query-count regression — batched overlay stays O(1) as module count grows` test was replaced with `aggregate-scoped overlay — one getEditActionsByAggregateId call per module`, asserting `moduleCount` calls instead of a fixed `7`. All other existing tests continue to pass unmodified, since none of them assert on query count or shape beyond this one test.

## 6. Non-Goals

- No adoption of `Overlaid<T>` / `pendingChangeStatus` / `diffEntity` (pattern doc §4) — the future design doc (`edit-crud/overall-design.md`) it depends on does not exist in the repo. Overlay helpers return plain `T[]`, not `Overlaid<T>[]`.
- No change to `queryParameterDefinitions` visibility (LLD §5.4 issue #3) or the misleading "separate aggregate" comment (LLD §5.4 issue #4) — deferred.
- No new tests for `getModuleDefinitionSystemId`/`getParameterDefinition` — deferred.

## 7. Amendment — `loadOverlaidDefinitionRows` fetch strategy reversal (post-implementation)

After the initial four-task refactor (§1–§6) shipped and passed, a follow-up discussion reconsidered `loadOverlaidDefinitionRows`'s fetch strategy. The original table-scoped batching (6 `getEditActionsByTable` calls, one per overlaid table, regardless of how many modules matched) fetches **session-wide** edit-actions for each table, then discards everything not belonging to the requested modules after bucketing by `aggregateId`. For small requests — get-by-id, or lists of a handful of modules — this over-fetches: a session with edits scattered across many modules pulls all of them just to keep 1–2.

**Decision:** switch to aggregate-scoped fetching — one `getEditActionsByAggregateId(sessionId, row.systemId)` call per module in the requested set, run concurrently via `Promise.all`. Each call returns only that module's own actions across every child table (per the existing single-row contract already used by `getDefinition`'s original design), eliminating the over-fetch entirely.

**Trade-off accepted:** query count becomes O(N) instead of the previous fixed O(1). This is the right call while list sizes stay small (get-by-id is the dominant case; `getAllSpfModuleDefinitionSummaries` lists are not expected to reach the scale where N queries becomes the bottleneck). If list sizes grow large enough for this to matter, revisit — e.g. a size-based dynamic switch between the two strategies — as a separate follow-up, not implicitly reintroduced here.

**Changes:**
- `loadOverlaidDefinitionRows` no longer calls `getEditActionsByTable`; it calls `getEditActionsByAggregateId` once per row in `baseRows`, concurrently, and maps each row directly to its own actions array (no more merge-then-bucket-by-`aggregateId` step — each call is already scoped to one aggregate).
- The `actionsByAggregateId` intermediate map is removed — no longer needed since each `getEditActionsByAggregateId` result is already aggregate-scoped.
- Test: `query-count regression — batched overlay stays O(1) as module count grows` replaced with `aggregate-scoped overlay — one getEditActionsByAggregateId call per module`, asserting the call count equals `moduleCount` (was a fixed `7`).
- No change to `overlayModuleDefinitionTree` or any Layer-2/Layer-3 helper from §2 — this amendment only changes how `actions` is obtained for each row, not how it's applied. Every helper added in §2.2/§2.3 is unaffected.
- No change to `loadParameterDefinitionsForModules` — it still uses `getEditActionsByTable` for the parameter table; this amendment is scoped to `loadOverlaidDefinitionRows` only. (Revisit together if the same over-fetch concern is judged to apply there too — not addressed by this amendment.)
