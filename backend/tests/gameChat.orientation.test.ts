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

import { applyGameStateToolCalls } from "../src/services/gameSystem/gameChat";
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
