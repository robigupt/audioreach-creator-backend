# SPF Module Definition Query Service — Overlay Pattern Refactor Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `DbSpfModuleDefinitionQueryService`'s overlay/mapping logic into the three-layer pattern (DB Query / Overlay / Mapping) from `docs/superpowers/specs/query-service-overlay-pattern.md`, with one granular private helper per table plus two thin composers — with zero change to any public method's observable behavior.

**Architecture:** Six new Layer-2 overlay helpers (`overlayModuleDefinitionRow`, `overlayPortGroups`, `overlayPorts`, `overlayStaticPorts`, `overlayStaticIntents`, `overlayDynamicIntents`) plus the existing-but-renamed `overlayParameterDefs`, composed by a new `overlayModuleDefinitionTree` that replaces `overlayDefinitionTree`. Six new/renamed Layer-3 mapping helpers (`mapPortGroups`, `mapPorts`, `mapStaticPorts`, `mapStaticIntents`, `mapDynamicIntents`, `mapContainerTypes`, `mapParameterDefs`), composed by a new `mapModuleInfoSummary` that replaces `toModuleInfoSummary` + `assembleFullDetails`. Layer 1 (DB queries) is untouched.

**Verification approach (adapted TDD):** This is a pure structural refactor with no new behavior (design doc §1, requirement FR-1) — there is no new failing test to write. The existing integration suite (`packages/infrastructure/persistence/tests/integration/queries/spf-module-definition/db-spf-module-definition-query-service.spec.ts`) is the regression guard. Each task's steps are: (1) confirm the suite is green before the change, (2) make the change, (3) confirm the suite is still green after — identical assertions, no modifications to the test file itself.

**Tech Stack:** TypeScript, TypeORM (`persistence-typeorm-sqllite`), Jest (`ts-jest`, ESM via `--experimental-vm-modules`).

**Package:** `@arc/persistence` (root: `packages/infrastructure/persistence`)

**Test command:** `pnpm --filter @arc/persistence run test:persistence -- --testPathPattern="db-spf-module-definition-query-service"`

**Target file (all tasks modify only this file):** `packages/infrastructure/persistence/src/persistence-typeorm-sqllite/queries/spf-module-definition/db-spf-module-definition-query-service.ts`

---

### Task 1: Extract root-row and dynamic-intents overlay helpers

**Package:** `@arc/persistence`

**Files:**
- Modify: `packages/infrastructure/persistence/src/persistence-typeorm-sqllite/queries/spf-module-definition/db-spf-module-definition-query-service.ts`
- Test (regression guard, not modified): `packages/infrastructure/persistence/tests/integration/queries/spf-module-definition/db-spf-module-definition-query-service.spec.ts`

- [ ] **Step 1: Confirm baseline is green**

Run: `pnpm --filter @arc/persistence run test:persistence -- --testPathPattern="db-spf-module-definition-query-service"`
Expected: PASS (all existing `describe` blocks green) — this is the baseline before any change in this plan.

- [ ] **Step 2: Add `overlayModuleDefinitionRow` and `overlayDynamicIntents` as new private methods**

Add these two new private methods anywhere in the `// ── Overlay methods` section of the class (immediately before the existing `overlayDefinitionTree` method, which stays in place untouched until Task 2):

```typescript
  private overlayModuleDefinitionRow(
    row: SpfModuleDefinitionRow,
    actions: EditActionRow[],
  ): SpfModuleDefinitionRow | null {
    return applyTableOverlay(row, actions, ENTITY_NAMES.SpfModuleDefinition);
  }

  private overlayDynamicIntents(
    rows: DynamicIntentDefinitionRow[],
    actions: EditActionRow[],
  ): DynamicIntentDefinitionRow[] {
    return applyToCollection(
      rows,
      actions.filter(a => a.tableName === ENTITY_NAMES.DynamicIntentDefinition),
    );
  }
```

Add the missing type import at the top of the file, alongside the existing `SpfModuleDefinitionRow`/`SpfModuleParameterDefinitionRow` imports:

```typescript
import type {DynamicIntentDefinitionRow} from '../../entity-schema/definitions/module/spf/dynamic-intent-definition.schema.js';
```

These two methods are not called anywhere yet — that wiring happens in Task 2, alongside deleting the old `overlayDefinitionTree`. Adding them now, unused, keeps this task's diff small and reviewable in isolation.

- [ ] **Step 3: Confirm suite is still green**

Run: `pnpm --filter @arc/persistence run test:persistence -- --testPathPattern="db-spf-module-definition-query-service"`
Expected: PASS — identical to Step 1's result. The two new methods are unused dead code at this point, so behavior is unchanged by construction.

- [ ] **Step 4: Commit**

  Use the `commit` skill to draft the commit message. Show the proposed message
  and the exact commands to the user and **wait for explicit confirmation** before
  running anything:

  ```bash
  git add packages/infrastructure/persistence/src/persistence-typeorm-sqllite/queries/spf-module-definition/db-spf-module-definition-query-service.ts
  git commit -m "refactor(spf-module-definition): add root and dynamic-intent overlay helpers" \
             -m "First step of splitting DbSpfModuleDefinitionQueryService's overlay logic into per-table Layer-2 helpers, per docs/superpowers/specs/query-service-overlay-pattern.md. Helpers are unused until the composer swap in the next commit." \
             -m "Signed-off-by: Robin Gupta <robigupt@qti.qualcomm.com>"
  ```

  **STOP — do not run `git commit` until the user explicitly approves the message.**
  Only execute after confirmation.

---

### Task 2: Add port/static-port overlay helpers, build the tree composer, and remove `overlayDefinitionTree`

**Package:** `@arc/persistence`

**Files:**
- Modify: `packages/infrastructure/persistence/src/persistence-typeorm-sqllite/queries/spf-module-definition/db-spf-module-definition-query-service.ts`
- Test (regression guard, not modified): `packages/infrastructure/persistence/tests/integration/queries/spf-module-definition/db-spf-module-definition-query-service.spec.ts`

- [ ] **Step 1: Confirm baseline is green**

Run: `pnpm --filter @arc/persistence run test:persistence -- --testPathPattern="db-spf-module-definition-query-service"`
Expected: PASS (baseline from Task 1's final state).

- [ ] **Step 2: Add the remaining four overlay helpers, the tree composer, and delete `overlayDefinitionTree`**

Add these four new private methods next to `overlayModuleDefinitionRow`/`overlayDynamicIntents` from Task 1:

```typescript
  private overlayPortGroups(
    rows: DataPortGroupRow[],
    actions: EditActionRow[],
  ): DataPortGroupRow[] {
    return applyToCollection(
      rows,
      actions.filter(a => a.tableName === ENTITY_NAMES.DataPortGroup),
    );
  }

  private overlayPorts(
    rows: DataPortDefinitionRow[],
    actions: EditActionRow[],
  ): DataPortDefinitionRow[] {
    return applyToCollection(
      rows,
      actions.filter(a => a.tableName === ENTITY_NAMES.DataPortDefinition),
    );
  }

  private overlayStaticPorts(
    rows: StaticControlPortDefinitionRow[],
    actions: EditActionRow[],
  ): StaticControlPortDefinitionRow[] {
    return applyToCollection(
      rows,
      actions.filter(
        a => a.tableName === ENTITY_NAMES.StaticControlPortDefinition,
      ),
    );
  }

  private overlayStaticIntents(
    rows: StaticIntentDefinitionRow[],
    actions: EditActionRow[],
  ): StaticIntentDefinitionRow[] {
    return applyToCollection(
      rows,
      actions.filter(a => a.tableName === ENTITY_NAMES.StaticIntentDefinition),
    );
  }
```

Add the following four type imports at the top of the file, alongside the `DynamicIntentDefinitionRow` import added in Task 1 — the current file has none of these four imported explicitly (it only accesses them implicitly through `SpfModuleDefinitionRow`'s relation fields, with no type-level reference by name):

```typescript
import type {DataPortGroupRow} from '../../entity-schema/definitions/module/spf/data-group-definition.schema.js';
import type {DataPortDefinitionRow} from '../../entity-schema/definitions/module/spf/data-port-definition.schema.js';
import type {StaticControlPortDefinitionRow} from '../../entity-schema/definitions/module/spf/static-control-port-definition.schema.js';
import type {StaticIntentDefinitionRow} from '../../entity-schema/definitions/module/spf/static-intent-definition.schema.js';
```

Add the tree composer immediately after the six helpers above:

```typescript
  /**
   * Composes the six per-table overlay helpers into the full
   * SpfModuleDefinition tree: root → dataPortGroups → ports,
   * staticPorts → staticIntents, dynamicIntents. Always overlays every
   * leaf table — replaces overlayDefinitionTree, which gated leaf overlay
   * behind an `includeLeafDetails` flag that every live caller already
   * passed as `true` (the summary read model has no summary/fullDetails
   * toggle; getDefinition derives its own split downstream in
   * summaryToDefinitionReadModel, not via overlay-skipping).
   */
  private overlayModuleDefinitionTree(
    row: SpfModuleDefinitionRow,
    actions: EditActionRow[],
  ): SpfModuleDefinitionRow {
    const overlaidDef = this.overlayModuleDefinitionRow(row, actions) ?? row;

    const overlaidPortGroups = this.overlayPortGroups(
      overlaidDef.dataPortGroups ?? [],
      actions,
    ).map(g => ({
      ...g,
      ports: this.overlayPorts(g.ports ?? [], actions),
    }));

    const overlaidStaticPorts = this.overlayStaticPorts(
      overlaidDef.staticPorts ?? [],
      actions,
    ).map(p => ({
      ...p,
      staticIntents: this.overlayStaticIntents(p.staticIntents ?? [], actions),
    }));

    return {
      ...overlaidDef,
      dataPortGroups: overlaidPortGroups,
      staticPorts: overlaidStaticPorts,
      dynamicIntents: this.overlayDynamicIntents(
        overlaidDef.dynamicIntents ?? [],
        actions,
      ),
    };
  }
```

Delete the entire existing `overlayDefinitionTree` private method (the one taking `{includeLeafDetails}` as a third parameter — currently between the `overlayStaticIntents`-equivalent inline filters and the `// ── Assembly methods` section comment).

Update the one call site, inside `loadOverlaidDefinitionRows`:

```typescript
      map.set(
        baseRow.systemId,
        this.overlayDefinitionTree(baseRow, actions, {
          includeLeafDetails: true,
        }),
      );
```

to:

```typescript
      map.set(baseRow.systemId, this.overlayModuleDefinitionTree(baseRow, actions));
```

Grep the file for `includeLeafDetails` and `overlayDefinitionTree` after this edit — both must return zero matches, confirming the old method and its only flag are fully removed.

- [ ] **Step 3: Confirm suite is still green**

Run: `pnpm --filter @arc/persistence run test:persistence -- --testPathPattern="db-spf-module-definition-query-service"`
Expected: PASS — every existing overlay test (root/1-hop/2-hop UPDATE cases, cross-leakage checks, single-vs-list parity) must still pass unchanged. This is the task where behavior parity actually gets exercised — if any of these fail, the composer's tree assembly has a bug relative to the deleted `overlayDefinitionTree`.

- [ ] **Step 4: Run the O(1) batching regression test explicitly**

Run: `pnpm --filter @arc/persistence run test:persistence -- --testPathPattern="db-spf-module-definition-query-service" -t "query-count regression"`
Expected: PASS — confirms the composer swap didn't reintroduce per-row `getEditActionsBy*` calls (FR-4). `loadOverlaidDefinitionRows` still issues exactly 6 `getEditActionsByTable` calls total regardless of module count, since the composer only changes what happens to each row's `actions` slice after it's already been fetched and grouped.

- [ ] **Step 5: Commit**

  Use the `commit` skill to draft the commit message. Show the proposed message
  and the exact commands to the user and **wait for explicit confirmation** before
  running anything:

  ```bash
  git add packages/infrastructure/persistence/src/persistence-typeorm-sqllite/queries/spf-module-definition/db-spf-module-definition-query-service.ts
  git commit -m "refactor(spf-module-definition): compose overlay tree from per-table helpers" \
             -m "Replaces overlayDefinitionTree with overlayModuleDefinitionTree, composed from the six granular overlay helpers (per docs/superpowers/specs/query-service-overlay-pattern.md). Drops the includeLeafDetails flag — dead on every live call path, verified via grep before removal. No observable behavior change; existing integration suite and O(1) query-count regression test both pass unchanged." \
             -m "Signed-off-by: Robin Gupta <robigupt@qti.qualcomm.com>"
  ```

  **STOP — do not run `git commit` until the user explicitly approves the message.**
  Only execute after confirmation.

---

### Task 3: Add per-table mapping helpers

**Package:** `@arc/persistence`

**Files:**
- Modify: `packages/infrastructure/persistence/src/persistence-typeorm-sqllite/queries/spf-module-definition/db-spf-module-definition-query-service.ts`
- Test (regression guard, not modified): `packages/infrastructure/persistence/tests/integration/queries/spf-module-definition/db-spf-module-definition-query-service.spec.ts`

- [ ] **Step 1: Confirm baseline is green**

Run: `pnpm --filter @arc/persistence run test:persistence -- --testPathPattern="db-spf-module-definition-query-service"`
Expected: PASS (baseline from Task 2's final state).

- [ ] **Step 2: Add the seven mapping helpers as new private methods**

Add these methods in the `// ── Assembly methods` section, immediately before `assembleFullDetails` (which stays in place, unused by anything new, until Task 4 deletes it):

```typescript
  private mapPortGroups(rows: DataPortGroupRow[]): DataPortGroupReadModel[] {
    return rows.map(
      (g): DataPortGroupReadModel => ({
        systemId: g.systemId,
        portIoType: g.portIoType,
        maxAllowedPortCount: g.maxAllowedPortCount,
        ports: this.mapPorts(g.ports ?? []),
      }),
    );
  }

  private mapPorts(rows: DataPortDefinitionRow[]): DataPortDefinitionReadModel[] {
    return rows.map(
      (p): DataPortDefinitionReadModel => ({
        systemId: p.systemId,
        dataPortId: p.dataPortId,
        name: p.name ?? '',
      }),
    );
  }

  private mapStaticPorts(
    rows: StaticControlPortDefinitionRow[],
  ): ControlPortDefinitionReadModel[] {
    return rows.map(
      (p): ControlPortDefinitionReadModel => ({
        systemId: p.systemId,
        portId: p.portId,
        portName: p.portName ?? '',
        staticIntents: this.mapStaticIntents(p.staticIntents ?? []),
      }),
    );
  }

  private mapStaticIntents(
    rows: StaticIntentDefinitionRow[],
  ): StaticIntentDefinitionReadModel[] {
    return rows.map(
      (i): StaticIntentDefinitionReadModel => ({
        systemId: i.systemId,
        intentId: i.intentId,
        name: i.name ?? '',
      }),
    );
  }

  private mapDynamicIntents(
    rows: DynamicIntentDefinitionRow[],
  ): DynamicIntentDefinitionReadModel[] {
    return rows.map(
      (d): DynamicIntentDefinitionReadModel => ({
        systemId: d.systemId,
        intentId: d.intentId,
        name: d.name ?? '',
        maxPort: d.maxPort,
      }),
    );
  }

  private mapContainerTypes(
    links: ModuleDefinitionContainerTypeLinkRow[],
  ): ContainerTypeSummaryReadModel[] {
    return links
      .map(l => l.containerType)
      .filter((ct): ct is NonNullable<typeof ct> => ct != null)
      .map(ct => ({name: ct.name, value: String(ct.value)}));
  }

  private mapParameterDefs(
    rows: SpfModuleParameterDefinitionRow[],
  ): ParameterDefinitionReadModel[] {
    return rows.map(row => this.toParameterDefinitionReadModel(row));
  }
```

Add the missing type import at the top of the file, alongside the existing `DataPortGroupReadModel`/`DataPortDefinitionReadModel` imports (these two are already imported — only this one is new):

```typescript
import type {ModuleDefinitionContainerTypeLinkRow} from '../../entity-schema/definitions/module/spf/module-definition-container-type-link.schema.js';
```

`mapParameterDefs` wraps the existing `toParameterDefinitionReadModel` (kept as-is, single-row mapper) rather than replacing it — this satisfies the design's "one per-table array-taking mapping helper" shape without duplicating the field-selection logic already in `toParameterDefinitionReadModel`. None of these seven methods are called anywhere yet — wiring happens in Task 4.

- [ ] **Step 3: Confirm suite is still green**

Run: `pnpm --filter @arc/persistence run test:persistence -- --testPathPattern="db-spf-module-definition-query-service"`
Expected: PASS — identical to Step 1's result. All seven new methods are unused dead code at this point.

- [ ] **Step 4: Commit**

  Use the `commit` skill to draft the commit message. Show the proposed message
  and the exact commands to the user and **wait for explicit confirmation** before
  running anything:

  ```bash
  git add packages/infrastructure/persistence/src/persistence-typeorm-sqllite/queries/spf-module-definition/db-spf-module-definition-query-service.ts
  git commit -m "refactor(spf-module-definition): add per-table mapping helpers" \
             -m "Adds mapPortGroups/mapPorts/mapStaticPorts/mapStaticIntents/mapDynamicIntents/mapContainerTypes/mapParameterDefs as granular Layer-3 helpers, per docs/superpowers/specs/query-service-overlay-pattern.md. Unused until the composer swap in the next commit." \
             -m "Signed-off-by: Robin Gupta <robigupt@qti.qualcomm.com>"
  ```

  **STOP — do not run `git commit` until the user explicitly approves the message.**
  Only execute after confirmation.

---

### Task 4: Build the mapping composer and remove `assembleFullDetails`/`toModuleInfoSummary`

**Package:** `@arc/persistence`

**Files:**
- Modify: `packages/infrastructure/persistence/src/persistence-typeorm-sqllite/queries/spf-module-definition/db-spf-module-definition-query-service.ts`
- Test (regression guard, not modified): `packages/infrastructure/persistence/tests/integration/queries/spf-module-definition/db-spf-module-definition-query-service.spec.ts`

- [ ] **Step 1: Confirm baseline is green**

Run: `pnpm --filter @arc/persistence run test:persistence -- --testPathPattern="db-spf-module-definition-query-service"`
Expected: PASS (baseline from Task 3's final state).

- [ ] **Step 2: Add `mapModuleInfoSummary`, delete `assembleFullDetails`/`toModuleInfoSummary`, update call sites**

Add the mapping composer, next to the mapping helpers from Task 3:

```typescript
  /**
   * Composes the mapping helpers into ModuleInfoSummaryReadModel — replaces
   * toModuleInfoSummary + assembleFullDetails combined. Container type
   * links are read from the base DB only; overlayModuleDefinitionTree does
   * not overlay the containerTypeLinks join table (out of scope for this
   * phase — see original comment on the deleted toModuleInfoSummary).
   */
  private mapModuleInfoSummary(
    overlaidRow: SpfModuleDefinitionRow,
  ): ModuleInfoSummaryReadModel {
    const portGroups = this.mapPortGroups(overlaidRow.dataPortGroups ?? []);
    const staticCtrlPorts = this.mapStaticPorts(overlaidRow.staticPorts ?? []);
    const dynamicIntents = this.mapDynamicIntents(
      overlaidRow.dynamicIntents ?? [],
    );
    const containerTypeInfo = this.mapContainerTypes(
      overlaidRow.containerTypeLinks ?? [],
    );

    return {
      pidFramework: 0, // no column on spf_module_definitions yet
      stackSize: overlaidRow.stackSize,
      containerTypeInfo,
      metaData: undefined, // no column on spf_module_definitions yet
      reserved: undefined, // no column on spf_module_definitions yet
      inputDataPortInfo:
        portGroups.find(g => g.portIoType === PORT_IO_TYPE.Input) ?? null,
      outputDataPortInfo:
        portGroups.find(g => g.portIoType === PORT_IO_TYPE.Output) ?? null,
      staticCtrlPorts,
      dynamicIntents,
      moduleTypeInfo: undefined, // no column yet — parseModuleTypeInfo deferred with schema
      mdfModuleType: undefined, // no column yet — parseMdfModuleType deferred with schema
    };
  }
```

Delete the entire existing `assembleFullDetails` private method and the entire existing `toModuleInfoSummary` private method.

Update the one call site inside `loadSummaryReadModels`, where the summary object is assembled — change:

```typescript
        moduleInfo: this.toModuleInfoSummary(overlaidRow),
```

to:

```typescript
        moduleInfo: this.mapModuleInfoSummary(overlaidRow),
```

Update `loadParameterDefinitionsForModules` to use the new array-based helper instead of mapping row-by-row inline. Change:

```typescript
    const map = new Map<number, ParameterDefinitionReadModel[]>();
    for (const row of overlaidRows) {
      const bucket = map.get(row.spfModuleDefinitionSystemId) ?? [];
      bucket.push(this.toParameterDefinitionReadModel(row));
      map.set(row.spfModuleDefinitionSystemId, bucket);
    }
    return map;
```

to:

```typescript
    const rowsByModuleId = new Map<number, SpfModuleParameterDefinitionRow[]>();
    for (const row of overlaidRows) {
      const bucket = rowsByModuleId.get(row.spfModuleDefinitionSystemId) ?? [];
      bucket.push(row);
      rowsByModuleId.set(row.spfModuleDefinitionSystemId, bucket);
    }

    const map = new Map<number, ParameterDefinitionReadModel[]>();
    for (const [moduleId, rows] of rowsByModuleId) {
      map.set(moduleId, this.mapParameterDefs(rows));
    }
    return map;
```

Grep the file for `assembleFullDetails` and `toModuleInfoSummary` after this edit — both must return zero matches (aside from the doc comment on `mapModuleInfoSummary` referencing the deleted method by name for history, which is fine to leave or remove at your discretion — the grep check is for remaining *method definitions/calls*, not comments).

- [ ] **Step 3: Confirm suite is still green**

Run: `pnpm --filter @arc/persistence run test:persistence -- --testPathPattern="db-spf-module-definition-query-service"`
Expected: PASS — every existing test, including the `getDefinition — single-item path unaffected by batching refactor` case and the `getCustomModuleMetadata*` cases, must still pass unchanged.

- [ ] **Step 4: Commit**

  Use the `commit` skill to draft the commit message. Show the proposed message
  and the exact commands to the user and **wait for explicit confirmation** before
  running anything:

  ```bash
  git add packages/infrastructure/persistence/src/persistence-typeorm-sqllite/queries/spf-module-definition/db-spf-module-definition-query-service.ts
  git commit -m "refactor(spf-module-definition): compose mapping from per-table helpers" \
             -m "Replaces toModuleInfoSummary + assembleFullDetails with mapModuleInfoSummary, composed from the per-table mapping helpers added in the prior commit (per docs/superpowers/specs/query-service-overlay-pattern.md). loadParameterDefinitionsForModules now batches through mapParameterDefs instead of mapping row-by-row inline. No observable behavior change; existing integration suite passes unchanged." \
             -m "Signed-off-by: Robin Gupta <robigupt@qti.qualcomm.com>"
  ```

  **STOP — do not run `git commit` until the user explicitly approves the message.**
  Only execute after confirmation.

---

### Task 5: Full regression verification

**Package:** `@arc/persistence`

**Files:**
- No file changes — verification only.
- Test: `packages/infrastructure/persistence/tests/integration/queries/spf-module-definition/db-spf-module-definition-query-service.spec.ts`

- [ ] **Step 1: Run the full targeted spec file**

Run: `pnpm --filter @arc/persistence run test:persistence -- --testPathPattern="db-spf-module-definition-query-service"`
Expected: PASS — every `describe` block from the original spec (`getAllSpfModuleDefinitionSummaries — no session`, `— session overlay, single module`, `— multi-module cross-leakage checks`, `getSpfModuleDefinitionSummary — not found`, `query-count regression`, `getDefinition — single-item path unaffected`, `getCustomModuleMetadata`, `getCustomModuleMetadataBySystemIds`) still passes, with no test file edits across the whole plan (FR-5).

- [ ] **Step 2: Run the full persistence package test suite**

Run: `pnpm --filter @arc/persistence run test:persistence`
Expected: PASS — confirms no other spec file in the package (e.g. anything exercising `DbSpfModuleDefinitionQueryService` indirectly through a shared fixture or another query service) regressed.

- [ ] **Step 3: Grep-verify the deleted symbols are fully gone**

Run: `grep -rn "overlayDefinitionTree\|assembleFullDetails\|includeLeafDetails" packages/infrastructure/persistence/src/persistence-typeorm-sqllite/queries/spf-module-definition/db-spf-module-definition-query-service.ts`
Expected: no output (all three deleted symbols are fully removed — confirms Task 2 and Task 4's grep checks held after all subsequent edits).

- [ ] **Step 4: No commit for this task**

This task is verification-only — no files changed, nothing to commit. If Steps 1–3 all pass, the refactor is complete per FR-1 through FR-5. If anything fails, return to the task that introduced the regression, fix it there, and re-run this task's steps before proceeding.
