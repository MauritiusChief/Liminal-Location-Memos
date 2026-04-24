/// <reference types="jest" />

jest.mock("../src/services/scene/sceneObject", () => ({
  buildSceneFromRequest: jest.fn(),
}));

jest.mock("../src/services/scene/scenePrompt", () => ({
  buildScenePrompt: jest.fn(() => ""),
}));

jest.mock("../src/services/gameSystem/systemPrompts", () => ({
  BUILD_GAME_STATE_MANAGER_SYSTEM: jest.fn(() => ""),
  INDOOR_INITIAL_BOOK_MESSAGE_SYSTEM: "",
  OUTDOOR_INITIAL_BOOK_MESSAGE_SYSTEM: "",
  REGULAR_BOOK_MESSAGE_SYSTEM: "",
  VISUAL_DESCRIPTION_SYSTEM: "",
}));

jest.mock("../src/services/gameSystem/gameDebug", () => ({
  writeGameDebugRequest: jest.fn(),
  writeGameDebugResult: jest.fn(),
}));

jest.mock("../src/services/gameSystem/llm", () => ({
  generateJsonReplySingleMessage: jest.fn(),
  generateReplySingleMessage: jest.fn(),
  streamReplyFullMessages: jest.fn(),
  streamReplySingleMessage: jest.fn(),
}));

jest.mock("../src/services/gameSystem/gameSessionStore", () => ({
  cloneGameState: jest.requireActual("../src/services/gameSystem/gameSessionStore").cloneGameState,
  createRuntimeSession: jest.fn(),
  getRuntimeSession: jest.fn(),
  toClientGameSessionSnapshot: jest.requireActual("../src/services/gameSystem/gameSessionStore").toClientGameSessionSnapshot,
  updateRuntimeSession: jest.fn(),
}));

jest.mock("../src/services/osmNormalization/osmGate", () => {
  class MockOsmCoverageSyncRetryExhaustedError extends Error {
    constructor(message: string = "地图数据同步失败，请再次发送上一条消息重试。") {
      super(message);
      this.name = "OsmCoverageSyncRetryExhaustedError";
    }
  }

  return {
    OsmCoverageSyncRetryExhaustedError: MockOsmCoverageSyncRetryExhaustedError,
    ensureOsmCoverageForRequest: jest.fn(),
    syncOverpassCoverage: jest.fn(),
  };
});

import { buildSceneFromRequest } from "../src/services/scene/sceneObject";
import {
  generateJsonReplySingleMessage,
  streamReplyFullMessages,
} from "../src/services/gameSystem/llm";
import {
  writeGameDebugRequest,
  writeGameDebugResult,
} from "../src/services/gameSystem/gameDebug";
import {
  getRuntimeSession,
  updateRuntimeSession,
} from "../src/services/gameSystem/gameSessionStore";
import { OsmCoverageSyncRetryExhaustedError } from "../src/services/osmNormalization/osmGate";
import { applyGameStateToolCalls, streamGameTurn } from "../src/services/gameSystem/gameChat";
import type { GameSession, GameState } from "../src/services/gameSystem/gameSessionStore";

function buildGameState(): GameState {
  return {
    playerPosition: { lat: 0, lon: 0 },
    playerOrientation: 15,
    playerIndoorLocation: null,
    messageHistory: [],
    activeFieldVisualDescriptions: [],
    fieldVisualDescriptions: {},
    activeExteriorVisualDescriptions: [],
    exteriorVisualDescriptions: {},
    buildingSchemas: {},
    buildingRecords: {},
    activeVisibleLocations: [],
    sectorVisualDescriptions: {},
    activeSectorVisualDescriptions: [],
  };
}

function buildSession(): GameSession {
  return {
    sessionId: "session-1",
    gameState: buildGameState(),
    runtime: {
      pendingVisualDescription: false,
      queuedPlayerMessage: null,
      activeTurnId: null,
      pendingVisualDescriptionTask: null,
    },
  };
}

describe("applyGameStateToolCalls", () => {
  it("updates player orientation to the move bearing after a valid move", async () => {
    const gameState = buildGameState();

    await applyGameStateToolCalls(gameState, [
      {
        name: "move_player",
        arguments: {
          bearingDegrees: 450,
          distanceMeters: 10,
        },
      },
    ]);

    expect(gameState.playerPosition).not.toEqual({ lat: 0, lon: 0 });
    expect(gameState.playerOrientation).toBe(90);
  });

  it("does not update orientation when move_player arguments are invalid", async () => {
    const gameState = buildGameState();

    await applyGameStateToolCalls(gameState, [
      {
        name: "move_player",
        arguments: {
          bearingDegrees: "bad",
          distanceMeters: 10,
        },
      },
    ]);

    expect(gameState.playerPosition).toEqual({ lat: 0, lon: 0 });
    expect(gameState.playerOrientation).toBe(15);
  });
});

describe("streamGameTurn", () => {
  const mockedBuildSceneFromRequest = jest.mocked(buildSceneFromRequest);
  const mockedGenerateJsonReplySingleMessage = jest.mocked(generateJsonReplySingleMessage);
  const mockedStreamReplyFullMessages = jest.mocked(streamReplyFullMessages);
  const mockedWriteGameDebugRequest = jest.mocked(writeGameDebugRequest);
  const mockedWriteGameDebugResult = jest.mocked(writeGameDebugResult);
  const mockedGetRuntimeSession = jest.mocked(getRuntimeSession);
  const mockedUpdateRuntimeSession = jest.mocked(updateRuntimeSession);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("does not mutate the cached session when coverage sync fails", async () => {
    const session = buildSession();
    mockedGetRuntimeSession.mockResolvedValue(session);
    mockedBuildSceneFromRequest.mockRejectedValue(new OsmCoverageSyncRetryExhaustedError());

    await expect(streamGameTurn(session.sessionId, "向前走", jest.fn())).rejects.toThrow(
      "地图数据同步失败，请再次发送上一条消息重试。",
    );

    expect(session.gameState.messageHistory).toEqual([]);
    expect(session.gameState.playerIndoorLocation).toBeNull();
    expect(mockedUpdateRuntimeSession).not.toHaveBeenCalled();
    expect(mockedWriteGameDebugRequest).not.toHaveBeenCalled();
    expect(mockedWriteGameDebugResult).not.toHaveBeenCalled();
  });

  it("streams book message, commits session, and finishes visual description", async () => {
    const session = buildSession();
    const emitted: string[] = [];

    mockedGetRuntimeSession.mockResolvedValue(session);
    mockedBuildSceneFromRequest.mockResolvedValue({
      largestLevel: 0,
      microGrid: { cells: [] } as never,
      polarView: undefined,
    });
    mockedGenerateJsonReplySingleMessage.mockResolvedValueOnce({
      reply: "[]",
      reasoning: "",
    }).mockResolvedValueOnce({
      reply: JSON.stringify({ field: "visual notes", exteriors: [] }),
      reasoning: "",
    });
    mockedStreamReplyFullMessages.mockImplementation(async function* () {
      yield { replyDelta: "book ", done: false };
      yield { replyDelta: "reply", done: false };
      yield { done: true };
    });
    const result = await streamGameTurn(session.sessionId, "观察四周", async (event) => {
      emitted.push(event.type);
    });

    expect(result).toBe(session);
    expect(session.gameState.messageHistory).toEqual([
      { role: "player", content: "观察四周" },
      { role: "book", content: "book reply" },
    ]);
    expect(session.gameState.activeFieldVisualDescriptions).toHaveLength(1);
    expect(emitted).toEqual([
      "player_message_accepted",
      "book_reply_delta",
      "book_reply_delta",
      "book_done",
      "session_committed",
      "visual_description_started",
      "visual_description_done",
    ]);
    expect(mockedUpdateRuntimeSession).toHaveBeenCalledTimes(2);
    expect(mockedWriteGameDebugRequest).toHaveBeenCalledTimes(3);
    expect(mockedWriteGameDebugResult).toHaveBeenCalledTimes(3);
    expect(mockedWriteGameDebugRequest.mock.invocationCallOrder[0]).toBeLessThan(
      mockedGenerateJsonReplySingleMessage.mock.invocationCallOrder[0],
    );
    expect(mockedWriteGameDebugResult.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockedGenerateJsonReplySingleMessage.mock.invocationCallOrder[0],
    );
    expect(mockedWriteGameDebugRequest.mock.invocationCallOrder[1]).toBeLessThan(
      mockedStreamReplyFullMessages.mock.invocationCallOrder[0],
    );
    expect(mockedWriteGameDebugResult.mock.invocationCallOrder[1]).toBeGreaterThan(
      mockedStreamReplyFullMessages.mock.invocationCallOrder[0],
    );
  });

  it("queues one next turn while visual description is pending", async () => {
    const session = buildSession();
    const events: string[] = [];
    let resolvePending!: () => void;

    session.runtime.pendingVisualDescription = true;
    session.runtime.pendingVisualDescriptionTask = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });

    mockedGetRuntimeSession.mockResolvedValue(session);
    mockedBuildSceneFromRequest.mockResolvedValue({
      largestLevel: 0,
      microGrid: { cells: [] } as never,
      polarView: undefined,
    });
    mockedGenerateJsonReplySingleMessage.mockResolvedValueOnce({
      reply: "[]",
      reasoning: "",
    }).mockResolvedValueOnce({
      reply: JSON.stringify({ field: "visual notes", exteriors: [] }),
      reasoning: "",
    });
    mockedStreamReplyFullMessages.mockImplementation(async function* () {
      yield { replyDelta: "queued reply", done: false };
      yield { done: true };
    });
    const turnPromise = streamGameTurn(session.sessionId, "排队消息", async (event) => {
      events.push(event.type);
      if (event.type === "queued_next_turn") {
        session.runtime.pendingVisualDescription = false;
        session.runtime.pendingVisualDescriptionTask = null;
        resolvePending();
      }
    });

    await turnPromise;

    expect(events[0]).toBe("queued_next_turn");
    expect(session.gameState.messageHistory.at(-1)).toEqual({
      role: "book",
      content: "queued reply",
    });
  });

  it("writes exterior visual descriptions by building id", async () => {
    const session = buildSession();

    mockedGetRuntimeSession.mockResolvedValue(session);
    mockedBuildSceneFromRequest.mockResolvedValue({
      largestLevel: 0,
      microGrid: {
        cells: [[{
          baseKind: "building",
          baseFeatureId: "way/123",
          sourceFeatureIds: ["way/123"],
        }]],
      } as never,
      polarView: undefined,
    });
    mockedGenerateJsonReplySingleMessage.mockResolvedValueOnce({
      reply: "[]",
      reasoning: "",
    }).mockResolvedValueOnce({
      reply: JSON.stringify({
        field: "field notes",
        exteriors: [{ buildingId: "way/123", content: "exterior notes" }],
      }),
      reasoning: "",
    });
    mockedStreamReplyFullMessages.mockImplementation(async function* () {
      yield { replyDelta: "book reply", done: false };
      yield { done: true };
    });

    await streamGameTurn(session.sessionId, "看那栋建筑", jest.fn());

    expect(session.gameState.exteriorVisualDescriptions["way/123"]?.content).toBe("exterior notes");
    expect(session.gameState.activeExteriorVisualDescriptions).toEqual(["way/123"]);
  });
});
