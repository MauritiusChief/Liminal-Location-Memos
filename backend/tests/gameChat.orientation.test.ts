/// <reference types="jest" />

jest.mock("../src/services/scene/sceneObject", () => ({
  buildSceneFromRequest: jest.fn(),
}));

jest.mock("../src/services/scene/scenePrompt", () => ({
  buildScenePrompt: jest.fn(() => ""),
}));

jest.mock("../src/services/gameSystem/systemPrompts", () => ({
  BUILD_GAME_STATE_MANAGER_SYSTEM: jest.fn(() => ""),
  INITIAL_BOOK_MESSAGE_SYSTEM: "",
  OUTDOOR_VISUAL_DESCRIPTION_SYSTEM: "",
  REGULAR_BOOK_MESSAGE_SYSTEM: "",
}));

jest.mock("../src/services/gameSystem/gameDebug", () => ({
  writeGameDebugMarkdown: jest.fn(),
}));

jest.mock("../src/services/gameSystem/llm", () => ({
  generateJsonReplySingleMessage: jest.fn(),
  generateReplyFullMessages: jest.fn(),
  generateReplySingleMessage: jest.fn(),
}));

jest.mock("../src/services/gameSystem/gameSessionStore", () => ({
  createSession: jest.fn(),
  getSession: jest.fn(),
  updateSession: jest.fn(),
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
import { generateJsonReplySingleMessage, generateReplyFullMessages, generateReplySingleMessage } from "../src/services/gameSystem/llm";
import { getSession, updateSession } from "../src/services/gameSystem/gameSessionStore";
import { OsmCoverageSyncRetryExhaustedError } from "../src/services/osmNormalization/osmGate";
import { applyGameStateToolCalls, runGameTurn } from "../src/services/gameSystem/gameChat";
import type { GameSession } from "../src/services/gameSystem/gameSessionStore";

function buildSession(): GameSession {
  return {
    sessionId: "session-1",
    playerPosition: { lat: 0, lon: 0 },
    playerOrientation: 15,
    playerIndoorLocation: null,
    messageHistory: [],
    activeOutdoorVisualDescriptions: [],
    outdoorVisualDescriptions: {},
    buildingSchemas: {},
    levelVisualDescriptions: {},
  };
}

describe("applyGameStateToolCalls", () => {
  it("updates player orientation to the move bearing after a valid move", () => {
    const session = buildSession();

    applyGameStateToolCalls(session, [
      {
        name: "move_player",
        arguments: {
          bearingDegrees: 450,
          distanceMeters: 10,
        },
      },
    ]);

    expect(session.playerPosition).not.toEqual({ lat: 0, lon: 0 });
    expect(session.playerOrientation).toBe(90);
  });

  it("does not update orientation when move_player arguments are invalid", () => {
    const session = buildSession();

    applyGameStateToolCalls(session, [
      {
        name: "move_player",
        arguments: {
          bearingDegrees: "bad",
          distanceMeters: 10,
        },
      },
    ]);

    expect(session.playerPosition).toEqual({ lat: 0, lon: 0 });
    expect(session.playerOrientation).toBe(15);
  });
});

describe("runGameTurn", () => {
  const mockedBuildSceneFromRequest = jest.mocked(buildSceneFromRequest);
  const mockedGenerateJsonReplySingleMessage = jest.mocked(generateJsonReplySingleMessage);
  const mockedGenerateReplyFullMessages = jest.mocked(generateReplyFullMessages);
  const mockedGenerateReplySingleMessage = jest.mocked(generateReplySingleMessage);
  const mockedGetSession = jest.mocked(getSession);
  const mockedUpdateSession = jest.mocked(updateSession);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("does not mutate the cached session when coverage sync fails", async () => {
    const session = buildSession();
    mockedGetSession.mockResolvedValue(session);
    mockedBuildSceneFromRequest.mockRejectedValue(new OsmCoverageSyncRetryExhaustedError());

    await expect(runGameTurn(session.sessionId, "向前走")).rejects.toThrow(
      "地图数据同步失败，请再次发送上一条消息重试。",
    );

    expect(session.messageHistory).toEqual([]);
    expect(session.playerIndoorLocation).toBeNull();
    expect(mockedUpdateSession).not.toHaveBeenCalled();
  });

  it("updates and persists a cloned session after a successful turn", async () => {
    const session = buildSession();
    mockedGetSession.mockResolvedValue(session);
    mockedBuildSceneFromRequest.mockResolvedValue({
      largestLevel: 0,
      microGrid: { cells: [] } as never,
      polarView: undefined,
    });
    mockedGenerateJsonReplySingleMessage.mockResolvedValue({
      reply: "[]",
      reasoning: "",
    });
    mockedGenerateReplyFullMessages.mockResolvedValue({
      reply: "book reply",
      reasoning: "",
    });
    mockedGenerateReplySingleMessage.mockResolvedValue({
      reply: "visual notes",
      reasoning: "",
    });

    const result = await runGameTurn(session.sessionId, "观察四周");

    expect(result).toBeDefined();
    expect(result).not.toBe(session);
    expect(result?.messageHistory).toEqual([
      { role: "player", content: "观察四周" },
      { role: "book", content: "book reply" },
    ]);
    expect(session.messageHistory).toEqual([]);
    expect(mockedUpdateSession).toHaveBeenCalledWith(result);
  });
});
