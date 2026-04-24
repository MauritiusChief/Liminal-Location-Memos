/// <reference types="jest" />

jest.mock("../src/services/scene/sceneObject", () => ({
  buildSceneFromRequest: jest.fn(),
}));

jest.mock("../src/services/scene/scenePrompt", () => ({
  buildScenePrompt: jest.fn(() => "scene prompt"),
}));

jest.mock("../src/services/scene/polarViewPrompt", () => ({
  formatRelativeDirection: jest.fn(() => "前方"),
}));

jest.mock("../src/services/gameSystem/toolIndoorPosition.js", () => ({
  applySetPlayerIndoorLocationTool: jest.fn(),
  applySyncActiveIndoorLocationsTool: jest.fn(),
  buildBasicActiveIndoorLocations: jest.fn((state) => {
    if (!state.playerIndoorLocation) {
      return [];
    }

    return [{
      buildingId: state.playerIndoorLocation.buildingId,
      level: state.playerIndoorLocation.level,
      roomId: state.playerIndoorLocation.roomId,
    }];
  }),
  chooseInitialIndoorLocation: jest.fn(),
  ensureBuildingRecord: jest.fn(),
  ensureBuildingSchema: jest.fn(),
  findContainingBuildingFeatureId: jest.fn(),
  findLocationContext: jest.fn((record, location) => {
    if (!record || !location) {
      return null;
    }

    return {
      level: location.level,
      sectorName: "north",
      locationType: "room",
      roomId: location.roomId,
      roomDescription: "客厅",
    };
  }),
  formatBuildingRecordPrompt: jest.fn(() => "building record prompt"),
  generateBuildingRecord: jest.fn(),
  resolveVisibleIndoorLocation: jest.fn((record, location) => location),
}), { virtual: true });

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

import { buildSceneFromRequest } from "../src/services/scene/sceneObject";
import {
  generateJsonReplySingleMessage,
  streamReplyFullMessages,
} from "../src/services/gameSystem/llm";
import {
  getRuntimeSession,
  updateRuntimeSession,
} from "../src/services/gameSystem/gameSessionStore";
import { streamGameTurn } from "../src/services/gameSystem/gameChat";
import type { GameSession, GameState } from "../src/services/gameSystem/gameSessionStore";

function buildOutdoorGameState(): GameState {
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

function buildSession(gameState: GameState): GameSession {
  return {
    sessionId: "session-1",
    gameState,
    runtime: {
      pendingVisualDescription: false,
      queuedPlayerMessage: null,
      activeTurnId: null,
      pendingVisualDescriptionTask: null,
    },
  };
}

describe("streamGameTurn visual descriptions", () => {
  const mockedBuildSceneFromRequest = jest.mocked(buildSceneFromRequest);
  const mockedGenerateJsonReplySingleMessage = jest.mocked(generateJsonReplySingleMessage);
  const mockedStreamReplyFullMessages = jest.mocked(streamReplyFullMessages);
  const mockedGetRuntimeSession = jest.mocked(getRuntimeSession);
  const mockedUpdateRuntimeSession = jest.mocked(updateRuntimeSession);

  beforeEach(() => {
    jest.resetAllMocks();
    mockedBuildSceneFromRequest.mockResolvedValue({
      largestLevel: 0,
      microGrid: { cells: [] } as never,
      polarView: undefined,
    });
    mockedStreamReplyFullMessages.mockImplementation(async function* () {
      yield { replyDelta: "book reply", done: false };
      yield { done: true };
    });
  });

  it("skips writes when the extractor returns __NO_UPDATE__", async () => {
    const session = buildSession(buildOutdoorGameState());
    mockedGetRuntimeSession.mockResolvedValue(session);
    mockedGenerateJsonReplySingleMessage
      .mockResolvedValueOnce({ reply: "[]", reasoning: "" })
      .mockResolvedValueOnce({
        reply: JSON.stringify({
          field: "__NO_UPDATE__",
          exteriors: [{ buildingId: "way/123", content: "__NO_UPDATE__" }],
          sector: null,
        }),
        reasoning: "",
      });

    await streamGameTurn(session.sessionId, "观察四周", jest.fn());

    expect(session.gameState.fieldVisualDescriptions).toEqual({});
    expect(session.gameState.exteriorVisualDescriptions).toEqual({});
    expect(session.gameState.sectorVisualDescriptions).toEqual({});
    expect(mockedUpdateRuntimeSession).toHaveBeenCalledTimes(2);
  });
});
