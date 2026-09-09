/*
 * Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
 * SPDX-License-Identifier: BSD-3-Clause
 */

import type {Result} from '../../../../shared/result/result.js';
import type {SubgraphPropertyDefinitionSummaryReadModel} from '../../query-services/subgraph-property-definition/subgraph-property-definition-read-model.js';
import type {SubgraphPropertyDefinitionWithElementsReadModel} from '../../query-services/subgraph-property-definition/subgraph-property-definition-with-elements-read-model.js';

/**
 * Effective subgraph-property definition reads used by write handlers.
 * Implementations must apply the active edit-session overlay.
 */
export interface SubgraphPropertyDefinitionRepository {
  getAllSubgraphPropertyDefinitionsSummary(
    fileSystemId: number,
    propertyNaturalId?: number,
  ): Promise<Result<SubgraphPropertyDefinitionSummaryReadModel[]>>;

  getSubgraphPropertiesWithElements(
    fileSystemId: number,
  ): Promise<Result<SubgraphPropertyDefinitionWithElementsReadModel[]>>;

  getSubgraphPropertyWithElements(
    propertySystemId: number,
    fileSystemId: number,
  ): Promise<Result<SubgraphPropertyDefinitionWithElementsReadModel>>;
}
