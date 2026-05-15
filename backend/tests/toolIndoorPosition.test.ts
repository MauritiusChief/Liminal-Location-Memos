/// <reference types="jest" />

jest.mock("../src/db/sqlLoader", () => ({
  loadServiceSql: jest.fn(async () => ""),
}));

jest.mock("../src/services/buildingGeneration/buildingSchema", () => {
  const actual = jest.requireActual("../src/services/buildingGeneration/buildingSchema");
  return {
    ...actual,
    generateBuildingSchema: jest.fn(),
    pickRandom: jest.fn((values: unknown[]) => values[0]),
  };
});

import { generateBuildingSchema } from "../src/services/buildingGeneration/buildingSchema";
import {
  applySetPlayerIndoorLocationTool,
  chooseBuildingEntranceIndoorLocation,
} from "../src/services/gameSystem/toolIndoorPosition";
import { applySyncPlayerIndoorLocationsTool } from "../src/services/gameSystem/toolActiveIndoorLocations";
import { generateBuildingRecord } from "../src/services/buildingGeneration/buildingRecord";
import type { BuildingSchema } from "../src/services/buildingGeneration/buildingSchema";
import type { GameState } from "../src/services/gameSystem/gameSessionStore";

function buildGameState(): GameState {
  return {
    playerPosition: { lat: 0, lon: 0 },
    playerOrientation: 0,
    playerIndoorLocation: null,
    playerVisionRange: 500,
    playerStatus: {
      health: 100,
      blood_loss: 0, infection: 0, poisonous: 0, nerv_mis: 0,
      hydration: 100, calorie: 100, protein: 100,
      exceeded_heat: 0, essential_heat: 100,
      fatigue: 0,
      endurance: 100,
    },
    playerVisibleLocations: [],
    messageHistory: [],
    buildingSchemas: {},
    buildingRecords: {},
    weatherAnchors: [],
    chunckRecords: [],
    activeFieldVisualDescriptions: [],
    fieldVisualDescriptions: {},
    activeExteriorVisualDescriptions: [],
    exteriorVisualDescriptions: {},
    activeRoomVisualDescriptions: [],
    roomVisualDescriptions: {},
  };
}

function buildSchema(
  featureId: string,
  rooms: BuildingSchema["levels"][string]["sectors"][string]["rooms"],
): BuildingSchema {
  return {
    featureId,
    category: "apartment",
    centerPosition: { lat: 1, lon: 2 },
    levels: {
      ground: {
        description: "一楼",
        span: [1],
        sectors: {
          main: {
            area: 120,
            centerPosition: { lat: 1, lon: 2 },
            rooms,
          },
        },
      },
    },
  };
}

describe("chooseBuildingEntranceIndoorLocation", () => {
  it("prefers a level 1 entrance room", () => {
    const record = generateBuildingRecord(buildSchema("way/1", {
      lobby: { description: "大堂", count: 1, access: "entrance" },
      lounge: { description: "休息室", count: 1 },
    }));

    expect(chooseBuildingEntranceIndoorLocation(record)).toEqual({
      buildingId: "way/1",
      level: 1,
      sectorName: "main",
      locationType: "room",
      roomId: "lvl1_lobby",
      roomDescription: "大堂",
    });
  });

  it("falls back from suite surface to a suite subRoom when no entrance exists", () => {
    const record = generateBuildingRecord(buildSchema("way/2", {
      suite: {
        description: "家庭套房",
        count: 1,
        subRooms: {
          bedroom: { description: "卧室", count: 1 },
        },
      },
    }));

    expect(chooseBuildingEntranceIndoorLocation(record)).toEqual({
      buildingId: "way/2",
      level: 1,
      sectorName: "main",
      locationType: "subRoom",
      suiteId: "lvl1_suite",
      suiteDescription: "家庭套房",
      roomId: "lvl1_suite/bedroom",
      roomDescription: "卧室",
    });
  });
});

describe("applySetPlayerIndoorLocationTool", () => {
  const mockedGenerateBuildingSchema = jest.mocked(generateBuildingSchema);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("enter auto-generates a building record and places the player in a level 1 entrance room", async () => {
    const state = buildGameState();
    state.buildingSchemas["way/3"] = buildSchema("way/3", {
      entrance_hall: { description: "入口大厅", count: 1, access: "entrance" },
      suite: {
        description: "行政套房",
        count: 1,
        subRooms: {
          bedroom: { description: "卧室", count: 1 },
        },
      },
    });
    mockedGenerateBuildingSchema.mockResolvedValue({
      "way/3": buildSchema("way/3", {
        entrance_hall: { description: "入口大厅", count: 1, access: "entrance" },
        suite: {
          description: "行政套房",
          count: 1,
          subRooms: {
            bedroom: { description: "卧室", count: 1 },
          },
        },
      }),
    });

    await applySetPlayerIndoorLocationTool(state, {
      move: "enter",
      buildingId: "way/3",
      level: 9,
      roomId: "bad-room",
    });

    expect(state.buildingRecords["way/3"]).toBeDefined();
    expect(state.playerIndoorLocation).toEqual({
      buildingId: "way/3",
      level: 1,
      sectorName: "main",
      locationType: "room",
      roomId: "lvl1_entrance_hall",
      roomDescription: "入口大厅",
    });
  });

  it("allows move across buildings when the target room is occupiable", async () => {
    const state = buildGameState();
    state.playerIndoorLocation = {
      buildingId: "way/old",
      level: 1,
      sectorName: "main",
      locationType: "room",
      roomId: "lvl1_old_room",
      roomDescription: "旧房间",
    };
    state.buildingRecords["way/new"] = generateBuildingRecord(buildSchema("way/new", {
      lobby: { description: "大堂", count: 1, access: "entrance" },
      suite: {
        description: "居住套房",
        count: 1,
        subRooms: {
          study: { description: "书房", count: 1 },
        },
      },
    }));

    await applySetPlayerIndoorLocationTool(state, {
      move: "move",
      buildingId: "way/new",
      level: 1,
      suiteId: "lvl1_suite",
      roomId: "lvl1_suite/study",
    });

    expect(state.playerIndoorLocation).toEqual({
      buildingId: "way/new",
      level: 1,
      sectorName: "main",
      locationType: "subRoom",
      suiteId: "lvl1_suite",
      suiteDescription: "居住套房",
      roomId: "lvl1_suite/study",
      roomDescription: "书房",
    });
  });

  it("falls back to an occupiable room when move target omits a room id", async () => {
    const state = buildGameState();
    state.playerIndoorLocation = {
      buildingId: "way/4",
      level: 1,
      sectorName: "main",
      locationType: "room",
      roomId: "lvl1_lobby",
      roomDescription: "大堂",
    };
    state.buildingRecords["way/4"] = generateBuildingRecord(buildSchema("way/4", {
      lobby: { description: "大堂", count: 1, access: "entrance" },
      suite: {
        description: "居住套房",
        count: 1,
        subRooms: {
          bedroom: { description: "卧室", count: 1 },
        },
      },
    }));

    await applySetPlayerIndoorLocationTool(state, {
      move: "move",
      level: 1,
      suiteId: "suite",
    });

    expect(state.playerIndoorLocation?.buildingId).toBe("way/4");
    expect(state.playerIndoorLocation?.level).toBe(1);
    expect(state.playerIndoorLocation?.locationType).not.toBe("suite");
  });
});

describe("applySyncPlayerIndoorLocationsTool", () => {
  it("reveals valid extra indoor locations and does not hide the current location", () => {
    const state = buildGameState();
    state.playerIndoorLocation = {
      buildingId: "way/5",
      level: 1,
      sectorName: "main",
      locationType: "room",
      roomId: "lvl1_lobby",
      roomDescription: "大堂",
    };
    state.buildingRecords["way/5"] = generateBuildingRecord(buildSchema("way/5", {
      lobby: { description: "大堂", count: 1, access: "entrance" },
      suite: {
        description: "双人套房",
        count: 1,
        subRooms: {
          bedroom: { description: "卧室", count: 1 },
        },
      },
    }));
    state.playerVisibleLocations = [{
      buildingId: "way/5",
      level: 1,
      sectorName: "main",
      locationType: "room",
      roomId: "lvl1_lobby",
      roomDescription: "大堂",
    }];

    applySyncPlayerIndoorLocationsTool(state, {
      edit: "reveal",
      level: 1,
      suiteId: "lvl1_suite",
      roomId: "lvl1_suite/bedroom",
    });
    applySyncPlayerIndoorLocationsTool(state, {
      edit: "hide",
      level: 1,
      roomId: "lobby",
    });

    expect(state.playerVisibleLocations).toEqual([
      {
        buildingId: "way/5",
        level: 1,
        sectorName: "main",
        locationType: "room",
        roomId: "lvl1_lobby",
        roomDescription: "大堂",
      },
      {
        buildingId: "way/5",
        level: 1,
        sectorName: "main",
        locationType: "subRoom",
        suiteId: "lvl1_suite",
        suiteDescription: "双人套房",
        roomId: "lvl1_suite/bedroom",
        roomDescription: "卧室",
      },
    ]);
  });
});
