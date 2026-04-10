/// <reference types="jest" />

import type { Server } from "node:http";

jest.mock("overpass-ts", () => ({
  overpassJson: jest.fn(),
}));

jest.mock("../src/db/client", () => ({
  checkDatabaseHealth: jest.fn(async () => ({ enabled: false, ok: true })),
}));

jest.mock("../src/services/osmNormalization/osmGate", () => {
  class MockOsmCoverageSyncRetryExhaustedError extends Error {}

  return {
    OsmCoverageSyncRetryExhaustedError: MockOsmCoverageSyncRetryExhaustedError,
    syncOverpassCoverage: jest.fn(),
  };
});

jest.mock("../src/services/scene/microGridObject", () => ({
  buildMicroGrid: jest.fn(),
  fetchMicroGridFromDb: jest.fn(),
}));

jest.mock("../src/services/scene/microGridPrompt", () => ({
  buildLabeledMicroGrid: jest.fn(),
}));

jest.mock("../src/services/featureDetail", () => ({
  fetchFeatureDetailsFromDb: jest.fn(),
}));

jest.mock("../src/services/scene/polarViewObject", () => ({
  buildPolarViewFeature: jest.fn(),
  fetchScenePolarFeaturesFromDb: jest.fn(),
}));

jest.mock("../src/services/scene/polarViewLabeled", () => ({
  applyClusterMarkder: jest.fn(),
  buildPolarView: jest.fn(),
}));

jest.mock("../src/services/scene/polarViewFilter", () => ({
  applyVisualFilter: jest.fn(),
}));

jest.mock("../src/services/scene/polarViewOcclusion", () => ({
  applyOcclusion: jest.fn(),
  buildLeveledPolarView: jest.fn(),
}));

jest.mock("../src/services/scene/sceneObject", () => ({
  buildSceneFromRequest: jest.fn(),
}));

jest.mock("../src/services/scene/scenePrompt", () => ({
  buildScenePrompt: jest.fn(),
}));

jest.mock("../src/services/gameSystem/gameSessionStore", () => ({
  getSession: jest.fn(),
}));

jest.mock("../src/services/gameSystem/gameChat", () => ({
  runGameTurn: jest.fn(),
  startGame: jest.fn(),
}));

jest.mock("../src/services/gameSystem/llm", () => ({
  streamReplySingleMessage: jest.fn(),
}));

import { createApp } from "../src/app";
import { streamReplySingleMessage } from "../src/services/gameSystem/llm";

describe("/api/debug/llm stream route", () => {
  const mockedStreamReplySingleMessage = jest.mocked(streamReplySingleMessage);
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("Failed to determine test server port.");
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns 400 when message is missing", async () => {
    const response = await fetch(`${baseUrl}/api/debug/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: "sys", message: "" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Message is required." });
  });

  it("streams reply/reasoning deltas and ends with done", async () => {
    mockedStreamReplySingleMessage.mockImplementation(async function* () {
      yield { replyDelta: "hello", done: false };
      yield { reasoningDelta: "think", done: false };
      yield { done: true };
    });

    const response = await fetch(`${baseUrl}/api/debug/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: "sys", message: "ping" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");

    const body = await response.text();
    const lines = body.trim().split(/\r?\n/).map((line) => JSON.parse(line));

    expect(lines).toEqual([
      { type: "reply_delta", text: "hello" },
      { type: "reasoning_delta", text: "think" },
      { type: "done" },
    ]);
  });

  it("writes error event when stream generator throws", async () => {
    mockedStreamReplySingleMessage.mockImplementation(async function* () {
      yield { replyDelta: "partial", done: false };
      throw new Error("stream exploded");
    });

    const response = await fetch(`${baseUrl}/api/debug/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: "sys", message: "ping" }),
    });

    expect(response.status).toBe(200);

    const body = await response.text();
    const lines = body.trim().split(/\r?\n/).map((line) => JSON.parse(line));

    expect(lines).toEqual([
      { type: "reply_delta", text: "partial" },
      { type: "error", message: "stream exploded" },
    ]);
  });
});
