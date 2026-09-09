/*
 * Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
 * SPDX-License-Identifier: BSD-3-Clause
 */

import type {EntityManager} from 'typeorm';
import type {
  SubgraphRepository,
  SubgraphWithProperties,
  VcpmDefaultData,
  IdGenerationPort,
  SubgraphPropertyDefinitionSummaryReadModel,
  SubgraphPropertyDefinitionWithElementsReadModel,
  UnitOfWork,
  EditOptions,
  Subgraph,
  SessionChanged,
  SgkvEntry,
} from '@arc/core';
import {

  Result,
  Subgraph as SubgraphEntity,
  SubgraphPropertyDefinition,
,
} from '@arc/core';
import type {PendingChangeWriter} from '../../services/pending-change-writer.js';
import {ENTITY_NAMES} from '../../entity-schema/entity-table-names.js';
import {SubgraphOverlayFetcher} from '../../fetchers/subgraph-overlay-fetcher.js';
import {SubgraphPropertyDataFetcher} from '../../fetchers/subgraph-property-data-fetcher.js';
import {SubgraphSgkvFetcher} from '../../fetchers/subgraph-sgkv-fetcher.js';
import {SubgraphPropertyDataFetcher} from '../../fetchers/subgraph-property-data-fetcher.js';
import {ValueDefinitionFetcher} from '../../fetchers/definitions/key-value/value-definition-fetcher.js';
import {SubgraphPropertyDefinitionFetcher} from '../../fetchers/definitions/subgraph-property-definition-fetcher.js';
import {EditActionsQueryService} from '../../queries/edit-session/edit-actions-query-service.js';
import {OverlayMergeImpl} from '../../queries/edit-session/overlay-merge.js';
import type {SubgraphBase} from '../../entity-schema/usecase-data/subgraph/subgraph.schema.js';
import {TypeOrmSubgraphPropertyDefinitionRepository} from '../subgraph-property-definition/subgraph-property-definition.repository.js';
import {TypeOrmVcpmDefinitionRepository} from '../vcpm-definition/vcpm-definition.repository.js';

export class TypeOrmSubgraphRepository implements SubgraphRepository {
  private readonly subgraphFetcher: SubgraphOverlayFetcher;
  private readonly propertyDataFetcher: SubgraphPropertyDataFetcher;
  private readonly sgkvFetcher: SubgraphSgkvFetcher;
  private readonly propertyDataFetcher: SubgraphPropertyDataFetcher;
  private readonly valueDefFetcher: ValueDefinitionFetcher;
  private readonly propertyDefinitionFetcher: SubgraphPropertyDefinitionFetcher;
  private readonly editActions: EditActionsQueryService;
  private readonly overlay = new OverlayMergeImpl();
  private readonly vcpmDefinitionRepository: TypeOrmVcpmDefinitionRepository;

  constructor(
    private readonly writer: PendingChangeWriter,
    private readonly manager: EntityManager,
    private readonly uow: UnitOfWork,
    private readonly idGeneration: IdGenerationPort,
  ) {
    const editActionsQs = new EditActionsQueryService(manager);

    this.sgkvFetcher = new SubgraphSgkvFetcher(manager, editActionsQs);
    this.propertyDataFetcher = new SubgraphPropertyDataFetcher(
      manager,
      editActionsQs,
    );
    this.subgraphFetcher = new SubgraphOverlayFetcher(
      manager,
      editActionsQs,
      this.propertyDataFetcher,
      this.sgkvFetcher,
    );
    this.valueDefFetcher = new ValueDefinitionFetcher(manager, editActionsQs);
    this.propertyDefinitionFetcher = new SubgraphPropertyDefinitionFetcher(
      manager,
      editActionsQs,
    );
    this.vcpmDefinitionRepository = new TypeOrmVcpmDefinitionRepository(
      writer,
      manager,
      uow,
      idGeneration,
    );
  }

  // ── Reads ────────────────────────────────────────────────────────────────────

  async subgraphExists(
    systemId: number,
    fileSystemId: number,
  ): Promise<boolean> {
    const sessionId = this.uow.getWriteContext().session.sessionId;
    return (
      (await this.subgraphFetcher.fetchOne(
        systemId,
        fileSystemId,
        sessionId,
      )) !== null
    );
  }

  async deleteSubgraph(
    subgraphSystemId: number,
    _fileSystemId: number,
    options?: EditOptions,
  ): Promise<void> {
    const {session, groupId} = this.uow.getWriteContext();
    const subgraph = await this.subgraphFetcher.fetchOne(
      subgraphSystemId,
      session.fileSystemId,
      session.sessionId,
    );
    if (!subgraph) return;

    const properties = await this.propertyDataFetcher.fetchMany(
      [subgraphSystemId],
      session.sessionId,
    );
    const sgkvs = await this.sgkvFetcher.fetchMany(
      session.fileSystemId,
      session.sessionId,
      [subgraphSystemId],
    );
    const instanceBase = (await this.manager
      .getRepository(ENTITY_NAMES.VcpmInstance)
      .createQueryBuilder('instance')
      .where('instance.subgraphSystemId = :subgraphSystemId', {
        subgraphSystemId,
      })
      .getMany()) as Array<{systemId: number; subgraphSystemId: number}>;
    const instanceActionsForSession = await this.editActions.getByTable(
      session.sessionId,
      ENTITY_NAMES.VcpmInstance,
    );
    const instances = this.overlay
      .applyToCollection(
        instanceBase,
        instanceActionsForSession,
        payload => payload.subgraphSystemId === subgraphSystemId,
      )
      .map(result => result.effective);
    const instanceIds = instances.map(instance => instance.systemId);
    const vcpmCkvBase =
      instanceIds.length === 0
        ? []
        : ((await this.manager
            .getRepository(ENTITY_NAMES.VcpmCkv)
            .createQueryBuilder('vcpmCkv')
            .where('vcpmCkv.vcpmInstanceSystemId IN (:...instanceIds)', {
              instanceIds,
            })
            .getMany()) as Array<{
            systemId: number;
            vcpmInstanceSystemId: number;
          }>);
    const vcpmCkvActionsForSession = await this.editActions.getByTable(
      session.sessionId,
      ENTITY_NAMES.VcpmCkv,
    );
    const vcpmCkvs = this.overlay
      .applyToCollection(vcpmCkvBase, vcpmCkvActionsForSession, payload =>
        instanceIds.includes(payload.vcpmInstanceSystemId as number),
      )
      .map(result => result.effective);
    const vcpmCkvIds = vcpmCkvs.map(row => row.systemId);
    const vcpmPayloadBase =
      vcpmCkvIds.length === 0
        ? []
        : ((await this.manager
            .getRepository(ENTITY_NAMES.VcpmParameterPayload)
            .createQueryBuilder('payload')
            .where('payload.vcpmCkvSystemId IN (:...vcpmCkvIds)', {
              vcpmCkvIds,
            })
            .getMany()) as Array<{
            systemId: number;
            vcpmCkvSystemId: number;
          }>);
    const vcpmPayloadActionsForSession = await this.editActions.getByTable(
      session.sessionId,
      ENTITY_NAMES.VcpmParameterPayload,
    );
    const vcpmPayloads = this.overlay
      .applyToCollection(
        vcpmPayloadBase,
        vcpmPayloadActionsForSession,
        payload => vcpmCkvIds.includes(payload.vcpmCkvSystemId as number),
      )
      .map(result => result.effective);
    const ownedRows = [
      {targetTable: ENTITY_NAMES.SubgraphPropertyData, rows: properties},
      {targetTable: ENTITY_NAMES.VcpmParameterPayload, rows: vcpmPayloads},
      {targetTable: ENTITY_NAMES.VcpmCkv, rows: vcpmCkvs},
      {targetTable: ENTITY_NAMES.Sgkv, rows: sgkvs},
      {targetTable: ENTITY_NAMES.VcpmInstance, rows: instances},
    ];
    for (const owned of ownedRows) {
      for (const row of owned.rows as Array<{systemId: number}>) {
        await this.writer.writeDelete(
          {
            targetTable: owned.targetTable,
            targetSystemId: row.systemId,
            aggregateId: subgraphSystemId,
            ...options,
          },
          session.sessionId,
          groupId,
          this.manager,
        );
      }
    }
    await this.writer.writeDelete(
      {
        targetTable: ENTITY_NAMES.Subgraph,
        targetSystemId: subgraphSystemId,
        aggregateId: subgraphSystemId,
        ...options,
      },
      session.sessionId,
      groupId,
      this.manager,
    );
  }

  async getSgkvs(
    fileSystemId: number,
    sgSystemIds: readonly number[],
  ): Promise<SgkvEntry[]> {
    if (sgSystemIds.length === 0) return [];
    const sessionId = this.uow.getWriteContext().session.sessionId;

    const sgkvRows = await this.sgkvFetcher.fetchMany(fileSystemId, sessionId, [
      ...sgSystemIds,
    ]);
    if (sgkvRows.length === 0) return [];

    const allValueDefIds = [
      ...new Set(
        sgkvRows.flatMap(sg => sg.values.map(v => v.valueDefSystemId)),
      ),
    ];
    const valueDefs = await this.valueDefFetcher.fetchMany(
      allValueDefIds,
      sessionId,
    );
    const valueToKeyMap = new Map(
      valueDefs.map(v => [v.systemId, v.keySystemId]),
    );

    return sgkvRows.map(sgkv => ({
      sgSystemId: sgkv.subgraphSystemId,
      sgkvSystemId: sgkv.systemId,
      keyValues: sgkv.values
        .filter(v => valueToKeyMap.has(v.valueDefSystemId))
        .map(v => ({
          keyDefSystemId: valueToKeyMap.get(v.valueDefSystemId)!,
          valueDefSystemId: v.valueDefSystemId,
        })),
    }));
  }

  async getPropertyDefinitions(
    fileSystemId: number,
  ): Promise<SubgraphPropertyDefinition[]> {
    const definitions = await this.propertyDefinitionFetcher.fetchAll(
      fileSystemId,
      this.uow.getWriteContext().session.sessionId,
    );
    return definitions
      .toSorted((left, right) => left.systemId - right.systemId)
      .map(
        definition =>
          new SubgraphPropertyDefinition({
            systemId: definition.systemId,
            fileSystemId: definition.fileSystemId,
            propertyId: definition.propertyId,
            name: definition.name ?? '',
            description: definition.description ?? undefined,
            maxSize: definition.maxSize,
            type: definition.propertyType,
            elementsStructure: definition.elementsStructure ?? '',
            isVoice: Boolean(definition.isVoice),
          }),
      );
  }

  async findByIds(
    fileSystemId: number,
    sgSystemIds: readonly number[],
  ): Promise<Subgraph[]> {
    if (sgSystemIds.length === 0) return [];
    const sessionId = this.uow.getWriteContext().session.sessionId;
    const rows = await this.subgraphFetcher.fetchMany(fileSystemId, sessionId, {
      systemId: [...sgSystemIds],
    });
    return rows.map(r => this.hydrate(r));
  }

  async findIsMdfInScope(
    fileSystemId: number,
    sgSystemIds: readonly number[],
  ): Promise<Subgraph[]> {
    if (sgSystemIds.length === 0) return [];
    const sessionId = this.uow.getWriteContext().session.sessionId;
    const rows = await this.subgraphFetcher.fetchMdfInScope(
      fileSystemId,
      sessionId,
      [...sgSystemIds],
    );
    return rows.map(r => this.hydrate(r));
  }

  async findChangedInSession(
    fileSystemId: number,
  ): Promise<SessionChanged<Subgraph>> {
    const sessionId = this.uow.getWriteContext().session.sessionId;
    const changed = await this.subgraphFetcher.fetchChangedInSession(
      fileSystemId,
      sessionId,
    );
    return {
      added: changed.added.map(r => this.hydrate(r)),
      deleted: changed.deleted.map(r => this.hydrate(r)),
    };
  }

  // ── Writes ───────────────────────────────────────────────────────────────────

  async createSubgraph(
    subgraph: Subgraph,
    options?: EditOptions,
  ): Promise<void> {
    const {session, groupId} = this.uow.getWriteContext();

    await this.writer.writeCreate(
      {
        targetTable: ENTITY_NAMES.Subgraph,
        targetSystemId: subgraph.systemId,
        aggregateId: subgraph.systemId,
        payload: {
          subgraphId: subgraph.subgraphId,
          name: subgraph.name,
          isImported: subgraph.isImported,
          fileSystemId: subgraph.fileSystemId,
        },
        ...options,
      },
      session.sessionId,
      groupId,
      this.manager,
    );

    for (const prop of subgraph.properties) {
      await this.writer.writeCreate(
        {
          targetTable: ENTITY_NAMES.SubgraphPropertyData,
          targetSystemId: subgraph.systemId,
          aggregateId: subgraph.systemId,
          payload: {
            subgraphSystemId: subgraph.systemId,
            propertySystemId: prop.propertyDefinitionSystemId,
            payload: prop.getPayloadCopy() ?? null,
          },
          ...options,
        },
        session.sessionId,
        groupId,
        this.manager,
      );
    }
  }

  async getAggregate(
    subgraphSystemId: number,
    fileSystemId: number,
  ): Promise<SubgraphWithProperties | null> {
    const sessionId = this.uow.getWriteContext().session.sessionId;
    const overlaid = await this.subgraphFetcher.fetchOne(
      subgraphSystemId,
      fileSystemId,
      sessionId,
    );
    if (!overlaid) return null;
    return {
      systemId: overlaid.systemId,
      properties: overlaid.properties.map(p => ({
        systemId: p.systemId,
        propertySystemId: p.propertySystemId,
        payload: p.payload,
      })),
    };
  }

  async getAggregates(
    subgraphSystemIds: number[],
    fileSystemId: number,
  ): Promise<Map<number, SubgraphWithProperties>> {
    if (subgraphSystemIds.length === 0) return new Map();
    const sessionId = this.uow.getWriteContext().session.sessionId;

    // One query for all subgraph rows
    const rows = await this.subgraphFetcher.fetchMany(fileSystemId, sessionId, {
      systemId: subgraphSystemIds,
    });

    // One query for all property rows across all requested subgraphs
    const allProperties = await this.propertyDataFetcher.fetchMany(
      subgraphSystemIds,
      sessionId,
    );

    // Group properties by subgraphSystemId
    const propsBySubgraph = new Map<number, typeof allProperties>();
    for (const prop of allProperties) {
      const list = propsBySubgraph.get(prop.subgraphSystemId) ?? [];
      list.push(prop);
      propsBySubgraph.set(prop.subgraphSystemId, list);
    }

    const result = new Map<number, SubgraphWithProperties>();
    for (const row of rows) {
      result.set(row.systemId, {
        systemId: row.systemId,
        properties: (propsBySubgraph.get(row.systemId) ?? []).map(p => ({
          systemId: p.systemId,
          propertySystemId: p.propertySystemId,
          payload: p.payload,
        })),
      });
    }
    return result;
  }

  async getAllSubgraphPropertyDefinitionsSummary(
    fileSystemId: number,
    propertyNaturalId?: number,
  ): Promise<Result<SubgraphPropertyDefinitionSummaryReadModel[]>> {
    return this.propertyDefinitionRepository.getAllSubgraphPropertyDefinitionsSummary(
      fileSystemId,
      propertyNaturalId,
    );
  }

  async getSubgraphPropertiesWithElements(
    fileSystemId: number,
  ): Promise<Result<SubgraphPropertyDefinitionWithElementsReadModel[]>> {
    return this.propertyDefinitionRepository.getSubgraphPropertiesWithElements(
      fileSystemId,
    );
  }

  async getSubgraphPropertyWithElements(
    propertySystemId: number,
    fileSystemId: number,
  ): Promise<Result<SubgraphPropertyDefinitionWithElementsReadModel>> {
    return this.propertyDefinitionRepository.getSubgraphPropertyWithElements(
      propertySystemId,
      fileSystemId,
    );
  }

  private hydrate(row: SubgraphBase): SubgraphEntity {
    return new SubgraphEntity({
      systemId: row.systemId,
      subgraphId: row.subgraphId,
      name: row.name,
      isExported: row.isImported,
      fileSystemId: row.fileSystemId,
    });
  }

  async rename(subgraphSystemId: number, name: string): Promise<void> {
    const {session, groupId} = this.uow.getWriteContext();
    await this.writer.writeDelta(
      {
        targetTable: ENTITY_NAMES.Subgraph,
        targetSystemId: subgraphSystemId,
        aggregateId: subgraphSystemId,
        delta: {name},
      },
      session.sessionId,
      groupId,
      this.manager,
    );
  }

  async setPropertyData(
    subgraphSystemId: number,
    propertySystemId: number,
    data: Uint8Array,
  ): Promise<void> {
    const {session, groupId} = this.uow.getWriteContext();

    const effectiveSubgraph = await this.subgraphFetcher.fetchOne(
      subgraphSystemId,
      session.fileSystemId,
      session.sessionId,
    );
    const row = effectiveSubgraph?.properties.find(
      property => property.propertySystemId === propertySystemId,
    );

    if (!row) {
      throw new Error(
        `SubgraphPropertyData for property ${propertySystemId} not found on subgraph ${subgraphSystemId}.`,
      );
    }
    await this.writer.writeDelta(
      {
        targetTable: ENTITY_NAMES.SubgraphPropertyData,
        targetSystemId: row.systemId,
        aggregateId: subgraphSystemId,
        delta: {payload: data},
      },
      session.sessionId,
      groupId,
      this.manager,
    );
  }

  async getSubgraphIdsInSameUsecases(
    subgraphSystemId: number,
    _fileSystemId: number,
  ): Promise<number[]> {
    const usecaseRows = await this.manager
      .getRepository(ENTITY_NAMES.UseCaseSubgraph)
      .createQueryBuilder('ucs')
      .select('ucs.usecaseSystemId')
      .where('ucs.subgraphSystemId = :subgraphSystemId', {subgraphSystemId})
      .getRawMany<{ucs_usecaseSystemId: number}>();

    if (usecaseRows.length === 0) return [];
    const allUsecaseIds = usecaseRows.map(r => r.ucs_usecaseSystemId);

    const gkvRows = await this.manager
      .getRepository(ENTITY_NAMES.UsecaseGkvValues)
      .createQueryBuilder('ugkv')
      .select('ugkv.usecaseSystemId')
      .distinct(true)
      .where('ugkv.usecaseSystemId IN (:...ids)', {ids: allUsecaseIds})
      .getRawMany<{ugkv_usecaseSystemId: number}>();

    if (gkvRows.length === 0) return [];
    const nonZeroIds = gkvRows.map(r => r.ugkv_usecaseSystemId);

    const linkedRows = await this.manager
      .getRepository(ENTITY_NAMES.UseCaseSubgraph)
      .createQueryBuilder('ucs')
      .select('ucs.subgraphSystemId')
      .distinct(true)
      .where('ucs.usecaseSystemId IN (:...ids)', {ids: nonZeroIds})
      .andWhere('ucs.subgraphSystemId != :subgraphSystemId', {subgraphSystemId})
      .getRawMany<{ucs_subgraphSystemId: number}>();

    return linkedRows.map(r => r.ucs_subgraphSystemId);
  }

  async getSubgraphIdsInSameUsecasesForMany(
    subgraphSystemIds: number[],
    _fileSystemId: number,
  ): Promise<number[]> {
    if (subgraphSystemIds.length === 0) return [];

    const usecaseRows = await this.manager
      .getRepository(ENTITY_NAMES.UseCaseSubgraph)
      .createQueryBuilder('ucs')
      .select('ucs.usecaseSystemId')
      .distinct(true)
      .where('ucs.subgraphSystemId IN (:...ids)', {ids: subgraphSystemIds})
      .getRawMany<{ucs_usecaseSystemId: number}>();

    if (usecaseRows.length === 0) return [];
    const allUsecaseIds = usecaseRows.map(r => r.ucs_usecaseSystemId);

    const gkvRows = await this.manager
      .getRepository(ENTITY_NAMES.UsecaseGkvValues)
      .createQueryBuilder('ugkv')
      .select('ugkv.usecaseSystemId')
      .distinct(true)
      .where('ugkv.usecaseSystemId IN (:...ids)', {ids: allUsecaseIds})
      .getRawMany<{ugkv_usecaseSystemId: number}>();

    if (gkvRows.length === 0) return [];
    const nonZeroIds = gkvRows.map(r => r.ugkv_usecaseSystemId);

    const inputSet = new Set(subgraphSystemIds);
    const linkedRows = await this.manager
      .getRepository(ENTITY_NAMES.UseCaseSubgraph)
      .createQueryBuilder('ucs')
      .select('ucs.subgraphSystemId')
      .distinct(true)
      .where('ucs.usecaseSystemId IN (:...ids)', {ids: nonZeroIds})
      .getRawMany<{ucs_subgraphSystemId: number}>();

    return linkedRows
      .map(r => r.ucs_subgraphSystemId)
      .filter(id => !inputSet.has(id));
  }

  async addProperty(
    subgraphSystemId: number,
    propertyDefinitionSystemId: number,
    payload: Uint8Array,
  ): Promise<number> {
    const {session, groupId} = this.uow.getWriteContext();
    const newSystemId = await this.idGeneration.getNextId(session.fileSystemId);
    await this.writer.writeCreate(
      {
        targetTable: ENTITY_NAMES.SubgraphPropertyData,
        targetSystemId: newSystemId,
        aggregateId: subgraphSystemId,
        payload: {
          subgraphSystemId,
          propertySystemId: propertyDefinitionSystemId,
          payload,
        },
      },
      session.sessionId,
      groupId,
      this.manager,
    );
    return newSystemId;
  }

  async removeProperty(
    subgraphSystemId: number,
    propDataSystemId: number,
  ): Promise<void> {
    const {session, groupId} = this.uow.getWriteContext();
    await this.writer.writeDelete(
      {
        targetTable: ENTITY_NAMES.SubgraphPropertyData,
        targetSystemId: propDataSystemId,
        aggregateId: subgraphSystemId,
      },
      session.sessionId,
      groupId,
      this.manager,
    );
  }

  async removeAllVcpmCfgData(subgraphSystemId: number): Promise<void> {
    const {session, groupId} = this.uow.getWriteContext();

    // Query 1: IDs of all VcpmInstance rows for this subgraph
    const instanceRows = await this.manager
      .getRepository(ENTITY_NAMES.VcpmInstance)
      .createQueryBuilder('vi')
      .select('vi.systemId', 'systemId')
      .where('vi.subgraphSystemId = :subgraphSystemId', {subgraphSystemId})
      .getRawMany<{systemId: number}>();

    if (instanceRows.length === 0) return;
    const instanceIds = instanceRows.map(r => r.systemId);

    // Query 2: IDs of all VcpmCkv rows belonging to those instances
    const ckvRows = await this.manager
      .getRepository(ENTITY_NAMES.VcpmCkv)
      .createQueryBuilder('ckv')
      .select('ckv.systemId', 'systemId')
      .where('ckv.vcpmInstanceSystemId IN (:...ids)', {ids: instanceIds})
      .getRawMany<{systemId: number}>();

    const ckvIds = ckvRows.map(r => r.systemId);

    // Query 3: IDs of all VcpmParameterPayload rows belonging to those CKVs
    const payloadIds: number[] = [];
    if (ckvIds.length > 0) {
      const payloadRows = await this.manager
        .getRepository(ENTITY_NAMES.VcpmParameterPayload)
        .createQueryBuilder('pp')
        .select('pp.systemId', 'systemId')
        .where('pp.vcpmCkvSystemId IN (:...ids)', {ids: ckvIds})
        .getRawMany<{systemId: number}>();
      payloadIds.push(...payloadRows.map(r => r.systemId));
    }

    // Write phase: delete leaf → parent (FK order)
    for (const id of payloadIds) {
      await this.writer.writeDelete(
        {
          targetTable: ENTITY_NAMES.VcpmParameterPayload,
          targetSystemId: id,
          aggregateId: subgraphSystemId,
        },
        session.sessionId,
        groupId,
        this.manager,
      );
    }
    for (const id of ckvIds) {
      await this.writer.writeDelete(
        {
          targetTable: ENTITY_NAMES.VcpmCkv,
          targetSystemId: id,
          aggregateId: subgraphSystemId,
        },
        session.sessionId,
        groupId,
        this.manager,
      );
    }
    for (const id of instanceIds) {
      await this.writer.writeDelete(
        {
          targetTable: ENTITY_NAMES.VcpmInstance,
          targetSystemId: id,
          aggregateId: subgraphSystemId,
        },
        session.sessionId,
        groupId,
        this.manager,
      );
    }
  }

  async addVcpmCfgDefaultData(
    subgraphSystemId: number,
    defaults: readonly VcpmDefaultData[],
  ): Promise<void> {
    await this.vcpmDefinitionRepository.addVcpmCfgDefaultData(
      subgraphSystemId,
      defaults,
    );
  }
}
