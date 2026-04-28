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

import { formatGameStateManagerRecentMessageHistory } from "../src/services/gameSystem/agentStateManager";

describe("formatGameStateManagerRecentMessageHistory", () => {
  it("includes state changes for player messages with non-empty stateChange", () => {
    const result = formatGameStateManagerRecentMessageHistory([{
      role: "player",
      content: "向前走",
      stateChange: [{
        name: "move_player",
        arguments: {
          bearingDegrees: 0,
          distanceMeters: 3,
        },
      }],
    }]);

    expect(result).toContain("> **玩家输入**：");
    expect(result).toContain("> **游戏状态变化**：");
    expect(result).toContain('"name": "move_player"');
  });

  it("omits state change sections for missing or empty stateChange", () => {
    const result = formatGameStateManagerRecentMessageHistory([
      { role: "player", content: "观察四周" },
      { role: "player", content: "等待", stateChange: [] },
    ]);

    expect(result).toContain("> **玩家输入**：");
    expect(result).not.toContain("> **游戏状态变化**：");
    expect(result).not.toContain("（无游戏状态变化）");
  });
});
