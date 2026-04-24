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
  ...jest.requireActual("../src/services/gameSystem/gameSessionStore"),
  createRuntimeSession: jest.fn(),
  getRuntimeSession: jest.fn(),
  updateRuntimeSession: jest.fn(),
}));

import { syncDerivedPromptState, toWorldStatePrompt } from "../src/services/gameSystem/gameChat";
import { generateBuildingRecord } from "../src/services/gameSystem/toolIndoorPosition";
import type { GameState } from "../src/services/gameSystem/gameSessionStore";
import type { BuildingSchema } from "../src/services/gameSystem/buildingClassifier";

function buildGameState(): GameState {
  return {
    playerPosition: { lat: 0, lon: 0 },
    playerOrientation: 0,
    playerIndoorLocation: {
      buildingId: "way/10",
      level: 1,
      roomId: "lobby",
    },
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

function buildSchema(): BuildingSchema {
  return {
    featureId: "way/10",
    category: "apartment",
    centerPosition: { lat: 1, lon: 2 },
    levels: {
      ground: {
        description: "一楼",
        span: [1],
        sectors: {
          main: {
            area: 140,
            centerPosition: { lat: 1, lon: 2 },
            rooms: {
              lobby: { description: "大堂", count: 1, access: "entrance" },
              lounge: { description: "休息室", count: 1 },
              suite: {
                description: "家庭套房",
                count: 1,
                subRooms: {
                  bedroom: { description: "卧室", count: 1 },
                },
              },
            },
          },
        },
      },
    },
  };
}

describe("indoor world state prompt", () => {
  it("includes the building record only when onlyVisible is false", async () => {
    const state = buildGameState();
    state.buildingRecords["way/10"] = generateBuildingRecord(buildSchema());
    syncDerivedPromptState(state);

    const promptWithoutRecord = await toWorldStatePrompt(state, undefined, true);
    const promptWithRecord = await toWorldStatePrompt(state, undefined, false);

    expect(promptWithoutRecord).not.toContain("当前建筑的 Building Record：");
    expect(promptWithRecord).toContain("当前建筑的 Building Record：");
    expect(promptWithRecord).toContain("levels:");
    expect(promptWithRecord).toContain("    - suite suite: 家庭套房");
  });
});

describe("syncDerivedPromptState", () => {
  it("keeps valid revealed indoor locations and drops invalid ones", () => {
    const state = buildGameState();
    state.buildingRecords["way/10"] = generateBuildingRecord(buildSchema());
    state.activeVisibleLocations = [
      {
        buildingId: "way/10",
        level: 1,
        suiteId: "suite",
        roomId: "suite/bedroom",
      },
      {
        buildingId: "way/10",
        level: 9,
        roomId: "missing_room",
      },
    ];

    syncDerivedPromptState(state);

    expect(state.activeVisibleLocations).toEqual(expect.arrayContaining([
      {
        buildingId: "way/10",
        level: 1,
        roomId: "lobby",
      },
      {
        buildingId: "way/10",
        level: 1,
        roomId: "lounge",
      },
      {
        buildingId: "way/10",
        level: 1,
        suiteId: "suite",
      },
      {
        buildingId: "way/10",
        level: 1,
        suiteId: "suite",
        roomId: "suite/bedroom",
      },
    ]));
    expect(state.activeVisibleLocations).not.toEqual(expect.arrayContaining([
      {
        buildingId: "way/10",
        level: 9,
        roomId: "missing_room",
      },
    ]));
  });
});
