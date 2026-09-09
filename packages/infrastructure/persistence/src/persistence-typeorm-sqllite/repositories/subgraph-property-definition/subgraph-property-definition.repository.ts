/*
 * Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
 * SPDX-License-Identifier: BSD-3-Clause
 */

import type {EntityManager} from 'typeorm';
import type {
  SubgraphPropertyDefinitionRepository,
  SubgraphPropertyDefinitionSummaryReadModel,
  SubgraphPropertyDefinitionWithElementsReadModel,
  UnitOfWork,
} from '@arc/core';
import {
  ERROR_CODES,
  IssueFactory,
  ISSUE_ENTITY_TYPE,
  Result,
} from '@arc/core';
import {EditActionsQueryService} from '../../queries/edit-session/edit-actions-query-service.js';
import {SubgraphPropertyDefinitionFetcher} from '../../fetchers/definitions/subgraph-property-definition-fetcher.js';

export class TypeOrmSubgraphPropertyDefinitionRepository
  implements SubgraphPropertyDefinitionRepository
{
  private readonly fetcher: SubgraphPropertyDefinitionFetcher;

  constructor(
    manager: EntityManager,
    private readonly uow: UnitOfWork,
  ) {
    this.fetcher = new SubgraphPropertyDefinitionFetcher(
      manager,
      new EditActionsQueryService(manager),
    );
  }

  async getAllSubgraphPropertyDefinitionsSummary(
    fileSystemId: number,
    propertyNaturalId?: number,
  ): Promise<Result<SubgraphPropertyDefinitionSummaryReadModel[]>> {
    try {
      const rows = await this.fetchRows(fileSystemId);
      const filtered =
        propertyNaturalId === undefined
          ? rows
          : rows.filter(row => row.propertyId === propertyNaturalId);

      return Result.ok(
        filtered.map(row => ({
          systemId: row.systemId,
          propertyId: row.propertyId,
          name: row.name,
          description: row.description,
          propertyType: row.propertyType,
          isVoice: row.isVoice,
        })),
      );
    } catch (error) {
      return Result.fail(
        IssueFactory.parseError(
          ERROR_CODES.INTERNAL_ERROR,
          this.getReadErrorMessage(error),
        ),
      );
    }
  }

  async getSubgraphPropertiesWithElements(
    fileSystemId: number,
  ): Promise<Result<SubgraphPropertyDefinitionWithElementsReadModel[]>> {
    try {
      const rows = await this.fetchRows(fileSystemId);
      return Result.ok(rows.map(row => this.toReadModel(row)));
    } catch (error) {
      return Result.fail(
        IssueFactory.parseError(
          ERROR_CODES.INTERNAL_ERROR,
          this.getReadErrorMessage(error),
        ),
      );
    }
  }

  async getSubgraphPropertyWithElements(
    propertySystemId: number,
    fileSystemId: number,
  ): Promise<Result<SubgraphPropertyDefinitionWithElementsReadModel>> {
    try {
      const rows = await this.fetchRows(fileSystemId);
      const row = rows.find(candidate => candidate.systemId === propertySystemId);
      if (!row) {
        return Result.fail(
          IssueFactory.notFound(
            ISSUE_ENTITY_TYPE.SubgraphPropertyDefinition,
            propertySystemId,
          ),
        );
      }
      return Result.ok(this.toReadModel(row));
    } catch (error) {
      return Result.fail(
        IssueFactory.parseError(
          ERROR_CODES.INTERNAL_ERROR,
          this.getReadErrorMessage(error),
        ),
      );
    }
  }

  private async fetchRows(fileSystemId: number) {
    const sessionId = this.uow.getWriteContext().session.sessionId;
    return this.fetcher.fetchAll(fileSystemId, sessionId);
  }

  private toReadModel(
    row: Awaited<ReturnType<SubgraphPropertyDefinitionFetcher['fetchAll']>>[number],
  ): SubgraphPropertyDefinitionWithElementsReadModel {
    return {
      systemId: row.systemId,
      propertyId: row.propertyId,
      name: row.name,
      description: row.description,
      propertyType: row.propertyType,
      maxSize: row.maxSize,
      isVoice: row.isVoice,
      elementsStructure: row.elementsStructure ?? '',
    };
  }

  private getReadErrorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message
      : 'Failed to load subgraph property definitions';
  }
}
