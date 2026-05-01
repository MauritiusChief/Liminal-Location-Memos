/// <reference types="jest" />

jest.mock("../src/services/scene/sceneObject", () => ({
  buildSceneFromRequest: jest.fn(),
}));

jest.mock("../src/services/scene/scenePrompt", () => ({
  buildScenePrompt: jest.fn(() => ""),
}));

jest.mock("../src/services/gameSystem/agentBookComposer.js", () => ({
  formatFieldVisualDescriptionPrompt: jest.fn(() => ""),
  formatIndoorLocationPrompt: jest.fn(() => ""),
  formatVisibleLocationPrompt: jest.fn(() => ""),
}), { virtual: true });

jest.mock("../src/services/gameSystem/gameDebug.js", () => ({
  writeGameDebugRequest: jest.fn(),
  writeGameDebugResult: jest.fn(),
}), { virtual: true });

jest.mock("../src/services/gameSystem/llm.js", () => ({
  generateJsonReplySingleMessage: jest.fn(),
}), { virtual: true });

jest.mock("../src/services/gameSystem/systemPrompts.js", () => ({
  BUILD_GAME_STATE_MANAGER_SYSTEM: jest.fn(() => ""),
}), { virtual: true });

jest.mock("../src/services/gameSystem/toolIndoorPosition.js", () => ({
  applySetPlayerIndoorLocationTool: jest.fn(),
}), { virtual: true });

jest.mock("../src/services/gameSystem/toolMovePlayer.js", () => ({
  applyMovePlayerTool: jest.fn(),
}), { virtual: true });

import { toWorldStatePrompt, type WorldState } from "../src/services/gameSystem/agentStateManager";

function createWorldState(overrides: Partial<WorldState>): WorldState {
  return {
    playerPosition: { lat: 0, lon: 0 },
    playerOrientation: 0,
    playerIndoorLocation: null,
    playerVisionRange: 500,
    recentMessageHistory: [],
    playerBuildingRecords: {},
    activeVisibleLocations: [],
    activeFieldVisualDescriptions: {},
    activeExteriorVisualDescriptions: {},
    activeSectorVisualDescriptions: {},
    ...overrides,
  };
}

describe("toWorldStatePrompt building record focus", () => {
  it("focuses current building by region, floor, and building scope", async () => {
    const prompt = await toWorldStatePrompt(createWorldState({
      playerIndoorLocation: {
        buildingId: "way/current",
        level: 1,
        sectorName: "main",
        locationType: "room",
        roomId: "lvl1_lobby",
        roomDescription: "门厅",
      },
      playerBuildingRecords: {
        "way/current": {
          featureId: "way/current",
          category: "house",
          centerPosition: { lat: 1, lon: 2 },
          tags: {},
          levels: {
            1: {
              level: 1,
              description: "一层",
              sectors: {
                main: {
                  name: "main",
                  area: 100,
                  centerPosition: { lat: 1.1, lon: 2.1 },
                  rooms: {
                    lvl1_lobby: { roomId: "lvl1_lobby", description: "门厅", access: "entrance" },
                    lvl1_storage: { roomId: "lvl1_storage", description: "储物间" },
                  },
                },
                east: {
                  name: "east",
                  area: 40,
                  centerPosition: { lat: 1.2, lon: 2.2 },
                  rooms: {
                    lvl1_stairs: { roomId: "lvl1_stairs", description: "楼梯间", access: "vertical" },
                    lvl1_office: { roomId: "lvl1_office", description: "办公室" },
                    suite_lvl1: {
                      suiteId: "suite_lvl1",
                      description: "员工套房",
                      subRooms: {
                        "suite_lvl1/bedroom": { roomId: "suite_lvl1/bedroom", description: "卧室" },
                      },
                    },
                  },
                },
              },
            },
            2: {
              level: 2,
              description: "二层",
              sectors: {
                upper: {
                  name: "upper",
                  area: 80,
                  centerPosition: { lat: 1.3, lon: 2.3 },
                  rooms: {
                    lvl2_landing: { roomId: "lvl2_landing", description: "楼梯平台", access: "vertical" },
                    lvl2_bedroom: { roomId: "lvl2_bedroom", description: "卧室" },
                  },
                },
              },
            },
          },
        },
        "way/other": {
          featureId: "way/other",
          category: "garage",
          centerPosition: { lat: 3, lon: 4 },
          tags: {},
          levels: {
            1: {
              level: 1,
              description: "附属层",
              sectors: {
                annex: {
                  name: "annex",
                  area: 20,
                  centerPosition: { lat: 3.1, lon: 4.1 },
                  rooms: {
                    annex_entry: { roomId: "annex_entry", description: "入口间", access: "entrance" },
                    annex_link: { roomId: "annex_link", description: "连通间", access: "internal" },
                    annex_stairs: { roomId: "annex_stairs", description: "维修梯", access: "vertical" },
                    annex_storage: { roomId: "annex_storage", description: "储藏室" },
                  },
                },
              },
            },
          },
        },
      },
    }));

    expect(prompt).toContain("- 楼层 1: 一层\n  - 区域 main");
    expect(prompt).toContain("    - 房间 lvl1_storage: 储物间");
    expect(prompt).toContain("  - 区域 east [面积：40, 几何中心：(1.2, 2.2)]");
    expect(prompt).toContain("    - 房间 lvl1_stairs: 楼梯间 [通道类型：vertical]");
    expect(prompt).not.toContain("    - 房间 lvl1_office: 办公室");
    expect(prompt).not.toContain("套房 suite_lvl1");
    expect(prompt).toContain("- 楼层 2: 二层\n  - 区域 upper - 房间 lvl2_landing: 楼梯平台 [通道类型：vertical]");
    expect(prompt).not.toContain("区域 upper [面积");
    expect(prompt).not.toContain("房间 lvl2_bedroom: 卧室");
    expect(prompt).toContain("建筑ID：way/other");
    expect(prompt).toContain("房间 annex_entry: 入口间 [通道类型：entrance]");
    expect(prompt).toContain("房间 annex_link: 连通间 [通道类型：internal]");
    expect(prompt).not.toContain("房间 annex_stairs: 维修梯 [通道类型：vertical]");
    expect(prompt).not.toContain("区域 annex [面积");
  });

  it("keeps current suite sector fully expanded when located in a sub-room", async () => {
    const prompt = await toWorldStatePrompt(createWorldState({
      playerIndoorLocation: {
        buildingId: "way/suite",
        level: 3,
        sectorName: "residential",
        locationType: "subRoom",
        suiteId: "suite_lvl3_1",
        suiteDescription: "住家套房",
        roomId: "suite_lvl3_1/bedroom",
        roomDescription: "卧室",
      },
      playerBuildingRecords: {
        "way/suite": {
          featureId: "way/suite",
          category: "apartment",
          centerPosition: { lat: 5, lon: 6 },
          tags: {},
          levels: {
            3: {
              level: 3,
              description: "住宅层",
              sectors: {
                residential: {
                  name: "residential",
                  area: 90,
                  centerPosition: { lat: 5.1, lon: 6.1 },
                  rooms: {
                    suite_lvl3_1: {
                      suiteId: "suite_lvl3_1",
                      description: "住家套房",
                      subRooms: {
                        "suite_lvl3_1/bedroom": { roomId: "suite_lvl3_1/bedroom", description: "卧室" },
                        "suite_lvl3_1/bathroom": { roomId: "suite_lvl3_1/bathroom", description: "浴室" },
                      },
                    },
                    lvl3_hall: { roomId: "lvl3_hall", description: "走廊", access: "vertical" },
                  },
                },
              },
            },
          },
        },
      },
    }));

    expect(prompt).toContain("套房 suite_lvl3_1: 住家套房");
    expect(prompt).toContain("子房间 suite_lvl3_1/bedroom: 卧室");
    expect(prompt).toContain("子房间 suite_lvl3_1/bathroom: 浴室");
    expect(prompt).toContain("房间 lvl3_hall: 走廊 [通道类型：vertical]");
  });

  it("treats all buildings as external when player is not indoors", async () => {
    const prompt = await toWorldStatePrompt(createWorldState({
      playerIndoorLocation: null,
      playerBuildingRecords: {
        "way/outdoor": {
          featureId: "way/outdoor",
          category: "house",
          centerPosition: { lat: 7, lon: 8 },
          tags: {},
          levels: {
            1: {
              level: 1,
              description: "首层",
              sectors: {
                main: {
                  name: "main",
                  area: 60,
                  centerPosition: { lat: 7.1, lon: 8.1 },
                  rooms: {
                    outdoor_entry: { roomId: "outdoor_entry", description: "玄关", access: "entrance" },
                    outdoor_stairs: { roomId: "outdoor_stairs", description: "楼梯", access: "vertical" },
                    outdoor_room: { roomId: "outdoor_room", description: "客厅" },
                  },
                },
              },
            },
          },
        },
      },
    }));

    expect(prompt).toContain("房间 outdoor_entry: 玄关 [通道类型：entrance]");
    expect(prompt).not.toContain("房间 outdoor_stairs: 楼梯 [通道类型：vertical]");
    expect(prompt).not.toContain("房间 outdoor_room: 客厅");
    expect(prompt).not.toContain("区域 main [面积");
  });
});
