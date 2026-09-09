/*
 * Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
 * SPDX-License-Identifier: BSD-3-Clause
 */
import {jest, describe, it, expect} from '@jest/globals';
import {PutSubgraphScenarioHandler} from '../../../../../../src/application/usecase-designer/subgraph/put-scenario/put-subgraph-scenario.handler.js';
import {PutSubgraphScenarioCommand} from '../../../../../../src/application/usecase-designer/subgraph/put-scenario/put-subgraph-scenario.command.js';
import {ResourceNotFoundException} from '../../../../../../src/shared/exceptions/resource-not-found.exception.js';
import {InvalidOperationException} from '../../../../../../src/shared/exceptions/invalid-operation.exception.js';
import {Result} from '../../../../../../src/application/shared/result/result.js';
import {SUB_GRAPH_PROP_ID_SCENARIO_VALUE_AUDIO_PLAYBACK} from '../../../../../../src/domain/entities/definitions/spf-ids.js';

const SESSION = {sessionId: 1, fileSystemId: 7};
const GROUP_ID = 'g1';
const SCENARIO_DEF_SYS_ID = 50;
const SCENARIO_NATURAL_ID = 0x08001010;
const SCENARIO_ELEMENTS = JSON.stringify([
  {
    elementType: 'ConfigElement',
    name: 'scenario',
    dataType: 'UInt32',
    defaultValue: '1',
  },
]);

function uint32Payload(v: number) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}

function makeScenarioDef() {
  return {
    systemId: SCENARIO_DEF_SYS_ID,
    propertyId: SCENARIO_NATURAL_ID,
    name: 'scenario',
    description: '',
    propertyType: 'SPF',
    maxSize: 4,
    isVoice: false,
    elementsStructure: SCENARIO_ELEMENTS,
  };
}

function makeSubgraph(scenarioValue: number) {
  return {
    systemId: 10,
    properties: [
      {
        systemId: 200,
        propertySystemId: SCENARIO_DEF_SYS_ID,
        payload: uint32Payload(scenarioValue),
      },
    ],
  };
}

function makeUow(subgraph: any) {
  const setPropertyData = jest.fn().mockResolvedValue(undefined);
  const startTransaction = jest.fn().mockResolvedValue(undefined);
  const commit = jest.fn().mockResolvedValue(undefined);
  const rollback = jest.fn().mockResolvedValue(undefined);
  const isInTransaction = jest.fn().mockReturnValue(false);

  return {
    getWriteContext: jest
      .fn()
      .mockReturnValue({session: SESSION, groupId: GROUP_ID}),
    getSubgraphRepository: jest.fn().mockReturnValue({
      getAggregate: jest.fn().mockResolvedValue(subgraph),
      setPropertyData,
      addProperty: jest.fn().mockResolvedValue(999),
      removeProperty: jest.fn().mockResolvedValue(undefined),
      removeAllVcpmCfgData: jest.fn().mockResolvedValue(undefined),
    }),
    getSubgraphPropertyDefinitionRepository: jest.fn().mockReturnValue({
      getAllSubgraphPropertyDefinitionsSummary: jest
        .fn()
        .mockResolvedValue(Result.ok([makeScenarioDef()])),
      getSubgraphPropertiesWithElements: jest
        .fn()
        .mockResolvedValue(Result.ok([makeScenarioDef()])),
      getSubgraphPropertyWithElements: jest
        .fn()
        .mockResolvedValue(Result.ok(makeScenarioDef())),
    }),
    getVcpmDefinitionRepository: jest.fn().mockReturnValue({
      getAllVcpmModuleDefinitions: jest.fn().mockResolvedValue([]),
      addVcpmCfgDefaultData: jest.fn().mockResolvedValue(undefined),
    }),
    getModuleRepository: jest.fn().mockReturnValue({
      getModulesBySubgraphId: jest.fn().mockResolvedValue([]),
      wipeCalData: jest
        .fn()
        .mockResolvedValue({ckvsDeleted: [], zeroCkvsAdded: []}),
    }),
    startTransaction,
    commit,
    rollback,
    isInTransaction,
    _setPropertyData: setPropertyData,
    _commit: commit,
    _rollback: rollback,
  };
}

const AUDIO_RECORDING_ELEMENTS = [
  {
    type: 'ConfigElement',
    name: 'scenario',
    dataType: 'UInt32',
    value: '2',
    isReadOnly: false,
    description: '',
  },
] as any;

describe('PutSubgraphScenarioHandler', () => {
  it('throws ResourceNotFoundException when subgraph not found', async () => {
    const uow = makeUow(null) as any;
    const handler = new PutSubgraphScenarioHandler(uow);
    await expect(
      handler.handle(
        new PutSubgraphScenarioCommand(10, AUDIO_RECORDING_ELEMENTS),
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('returns empty mutation log when scenario unchanged', async () => {
    const uow = makeUow(
      makeSubgraph(SUB_GRAPH_PROP_ID_SCENARIO_VALUE_AUDIO_PLAYBACK),
    ) as any;
    const audioPlaybackElements = [
      {
        type: 'ConfigElement',
        name: 'scenario',
        dataType: 'UInt32',
        value: '1',
        isReadOnly: false,
        description: '',
      },
    ] as any;
    const handler = new PutSubgraphScenarioHandler(uow);
    const result = await handler.handle(
      new PutSubgraphScenarioCommand(10, audioPlaybackElements),
    );
    expect(result.propertiesAdded).toHaveLength(0);
    expect(uow._setPropertyData).not.toHaveBeenCalled();
  });

  it('commits scenario write for audio→audio change', async () => {
    const uow = makeUow(
      makeSubgraph(SUB_GRAPH_PROP_ID_SCENARIO_VALUE_AUDIO_PLAYBACK),
    ) as any;
    const handler = new PutSubgraphScenarioHandler(uow);
    const result = await handler.handle(
      new PutSubgraphScenarioCommand(10, AUDIO_RECORDING_ELEMENTS),
    );
    expect(uow._commit).toHaveBeenCalled();
    expect(result.groupId).toBe(GROUP_ID);
  });

  it('rolls back and rethrows when write fails', async () => {
    const uow = makeUow(
      makeSubgraph(SUB_GRAPH_PROP_ID_SCENARIO_VALUE_AUDIO_PLAYBACK),
    ) as any;
    uow
      .getSubgraphRepository()
      .setPropertyData.mockRejectedValueOnce(new Error('fail'));
    uow.isInTransaction.mockReturnValue(true);
    const handler = new PutSubgraphScenarioHandler(uow);
    await expect(
      handler.handle(
        new PutSubgraphScenarioCommand(10, AUDIO_RECORDING_ELEMENTS),
      ),
    ).rejects.toThrow('fail');
    expect(uow._rollback).toHaveBeenCalled();
  });

  it('throws InvalidOperationException when scenario serialization fails', async () => {
    const badElements = [
      {
        type: 'ConfigElement',
        name: 'scenario',
        dataType: 'UInt32',
        value: 'nan',
        isReadOnly: false,
        description: '',
      },
    ] as any;
    const uow = makeUow(
      makeSubgraph(SUB_GRAPH_PROP_ID_SCENARIO_VALUE_AUDIO_PLAYBACK),
    ) as any;
    const handler = new PutSubgraphScenarioHandler(uow);
    await expect(
      handler.handle(new PutSubgraphScenarioCommand(10, badElements)),
    ).rejects.toBeInstanceOf(InvalidOperationException);
  });
});
