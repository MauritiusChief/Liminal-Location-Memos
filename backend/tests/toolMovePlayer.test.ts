/// <reference types="jest" />

jest.mock("../src/services/buildingGeneration/buildingRecord", () => ({
  findContainingBuildingFeatureId: jest.fn(),
}));

import { findContainingBuildingFeatureId } from "../src/services/buildingGeneration/buildingRecord";
import {
  applyMovePlayerTool,
  listIndoorAdjustmentCandidates,
  movePosition,
} from "../src/services/gameSystem/toolMovePlayer";
import type { GameState, Position } from "../src/services/gameSystem/gameSessionStore";

const mockedFindContainingBuildingFeatureId = jest.mocked(findContainingBuildingFeatureId);

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

function expectPositionCloseTo(actual: Position, expected: Position): void {
  expect(actual.lat).toBeCloseTo(expected.lat, 10);
  expect(actual.lon).toBeCloseTo(expected.lon, 10);
}

function mockIndoorSequence(values: boolean[]): void {
  mockedFindContainingBuildingFeatureId.mockImplementation(async () => {
    const isIndoor = values.shift() ?? false;
    return isIndoor ? ({ featureId: "way/1", tags: {} }) : null;
  });
}

describe("applyMovePlayerTool", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("keeps the original destination when no indoor intent exists", async () => {
    const state = buildGameState();
    const expected = movePosition(state.playerPosition, 0, 10);

    await applyMovePlayerTool(state, { bearingDegrees: 0, distanceMeters: 10 });

    expectPositionCloseTo(state.playerPosition, expected);
    expect(mockedFindContainingBuildingFeatureId).not.toHaveBeenCalled();
  });

  it("keeps the original destination when it already matches an indoor intent", async () => {
    const state = buildGameState();
    const expected = movePosition(state.playerPosition, 0, 10);
    mockIndoorSequence([true]);

    await applyMovePlayerTool(state, { bearingDegrees: 0, distanceMeters: 10 }, true);

    expectPositionCloseTo(state.playerPosition, expected);
    expect(mockedFindContainingBuildingFeatureId).toHaveBeenCalledTimes(1);
  });

  it("keeps the original destination when it already matches an outdoor intent", async () => {
    const state = buildGameState();
    const expected = movePosition(state.playerPosition, 0, 10);
    mockIndoorSequence([false]);

    await applyMovePlayerTool(state, { bearingDegrees: 0, distanceMeters: 10 }, false);

    expectPositionCloseTo(state.playerPosition, expected);
    expect(mockedFindContainingBuildingFeatureId).toHaveBeenCalledTimes(1);
  });

  it("adjusts to the nearest forward candidate when the original destination mismatches", async () => {
    const state = buildGameState();
    const originalDestination = movePosition(state.playerPosition, 0, 10);
    const expected = movePosition(originalDestination, 0, 5);
    mockIndoorSequence([false, true]);

    await applyMovePlayerTool(state, { bearingDegrees: 0, distanceMeters: 10 }, true);

    expectPositionCloseTo(state.playerPosition, expected);
    expect(mockedFindContainingBuildingFeatureId).toHaveBeenCalledTimes(2);
  });

  it("adjusts to the nearest backward candidate when the forward candidate mismatches", async () => {
    const state = buildGameState();
    const originalDestination = movePosition(state.playerPosition, 0, 10);
    const expected = movePosition(originalDestination, 180, 5);
    mockIndoorSequence([false, false, true]);

    await applyMovePlayerTool(state, { bearingDegrees: 0, distanceMeters: 10 }, true);

    expectPositionCloseTo(state.playerPosition, expected);
    expect(mockedFindContainingBuildingFeatureId).toHaveBeenCalledTimes(3);
  });

  it("falls back to the original destination when no sampled point matches", async () => {
    const state = buildGameState();
    const expected = movePosition(state.playerPosition, 0, 10);
    mockIndoorSequence(Array.from({ length: 13 }, () => false));

    await applyMovePlayerTool(state, { bearingDegrees: 0, distanceMeters: 10 }, true);

    expectPositionCloseTo(state.playerPosition, expected);
    expect(mockedFindContainingBuildingFeatureId).toHaveBeenCalledTimes(13);
  });
});

describe("listIndoorAdjustmentCandidates", () => {
  it("orders candidates as original, forward, backward from near to far", () => {
    const destination = { lat: 0, lon: 0 };
    const candidates = listIndoorAdjustmentCandidates(destination, 90);

    expect(candidates).toHaveLength(13);
    expectPositionCloseTo(candidates[0]!, destination);
    expectPositionCloseTo(candidates[1]!, movePosition(destination, 90, 5));
    expectPositionCloseTo(candidates[2]!, movePosition(destination, 270, 5));
    expectPositionCloseTo(candidates[3]!, movePosition(destination, 90, 10));
    expectPositionCloseTo(candidates[4]!, movePosition(destination, 270, 10));
    expectPositionCloseTo(candidates[11]!, movePosition(destination, 90, 30));
    expectPositionCloseTo(candidates[12]!, movePosition(destination, 270, 30));
  });
});
