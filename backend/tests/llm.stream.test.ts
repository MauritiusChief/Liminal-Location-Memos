/// <reference types="jest" />

jest.mock("../src/config", () => ({
  config: {
    llmProvider: "openrouter",
    llmApiKey: "test-key",
    llmBaseUrl: "https://example.com",
    llmModel: "test-model",
  },
}));

import {
  buildFullMessagesRequestMessages,
  normalizeProviderStreamPayload,
  parseProviderStreamSegment,
} from "../src/services/gameSystem/llm";

describe("normalizeProviderStreamPayload", () => {
  it("normalizes reply delta chunks", () => {
    expect(normalizeProviderStreamPayload({
      choices: [{ delta: { content: "hello" } }],
    })).toEqual({
      replyDelta: "hello",
      reasoningDelta: undefined,
      done: false,
    });
  });

  it("normalizes reasoning delta chunks from reasoning_content", () => {
    expect(normalizeProviderStreamPayload({
      choices: [{ delta: { reasoning_content: "think" } }],
    })).toEqual({
      replyDelta: undefined,
      reasoningDelta: "think",
      done: false,
    });
  });

  it("normalizes reasoning delta chunks from reasoning", () => {
    expect(normalizeProviderStreamPayload({
      choices: [{ delta: { reasoning: "ponder" } }],
    })).toEqual({
      replyDelta: undefined,
      reasoningDelta: "ponder",
      done: false,
    });
  });

  it("returns null for empty chunks", () => {
    expect(normalizeProviderStreamPayload({
      choices: [{ delta: {} }],
    })).toBeNull();
  });

  it("marks finish_reason chunks as done", () => {
    expect(normalizeProviderStreamPayload({
      choices: [{ delta: {}, finish_reason: "stop" }],
    })).toEqual({
      replyDelta: undefined,
      reasoningDelta: undefined,
      done: true,
    });
  });
});

describe("buildFullMessagesRequestMessages", () => {
  it("maps basic player and book history, then appends current game state", () => {
    expect(buildFullMessagesRequestMessages("system", [
      { role: "player", content: "观察四周" },
      { role: "book", content: "你看到一条走廊。" },
    ], "state")).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "观察四周" },
      { role: "assistant", content: "你看到一条走廊。" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "",
        tool_calls: [{
          id: "synthetic_get_world_state",
          type: "function",
          function: { name: "refresh_world_state", arguments: "{}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "synthetic_get_world_state",
        content: "state",
      },
    ]);
  });

  it("rehydrates player state changes as synthetic assistant and tool messages", () => {
    const stateChange = [{
      name: "move_player",
      arguments: {
        bearingDegrees: 90,
        distanceMeters: 4,
      },
    }];

    expect(buildFullMessagesRequestMessages("system", [
      { role: "player", content: "向右走", stateChange },
    ], "state")).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "向右走" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "",
        tool_calls: [{
          id: "synthetic_player_state_change_0",
          type: "function",
          function: { name: "apply_player_state_changes", arguments: "{}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "synthetic_player_state_change_0",
        content: JSON.stringify(stateChange, null, 2),
      },
      {
        role: "assistant",
        content: "",
        reasoning_content: "",
        tool_calls: [{
          id: "synthetic_get_world_state",
          type: "function",
          function: { name: "refresh_world_state", arguments: "{}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "synthetic_get_world_state",
        content: "state",
      },
    ]);
  });

  it("keeps unique synthetic tool ids for multiple player messages with state changes", () => {
    const firstStateChange = [{
      name: "move_player",
      arguments: { bearingDegrees: 0, distanceMeters: 2 },
    }];
    const secondStateChange = [{
      name: "set_player_indoor_location",
      arguments: { move: "enter", buildingId: "way/1" },
    }];
    const messages = buildFullMessagesRequestMessages("system", [
      { role: "player", content: "向前走", stateChange: firstStateChange },
      { role: "book", content: "你站到门口。" },
      { role: "player", content: "进入房间", stateChange: secondStateChange },
    ], "state");

    const toolIds = messages
      .filter((message) => message.role === "assistant" && message.tool_calls?.length)
      .flatMap((message) => message.tool_calls?.map((toolCall) => toolCall.id) ?? []);

    expect(toolIds).toEqual([
      "synthetic_player_state_change_0",
      "synthetic_player_state_change_2",
      "synthetic_get_world_state",
    ]);
  });

  it("ignores an empty stateChange array when building synthetic tool messages", () => {
    const messages = buildFullMessagesRequestMessages("system", [
      { role: "player", content: "等待", stateChange: [] },
    ], "state");

    expect(messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "等待" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "",
        tool_calls: [{
          id: "synthetic_get_world_state",
          type: "function",
          function: { name: "refresh_world_state", arguments: "{}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "synthetic_get_world_state",
        content: "state",
      },
    ]);
  });
});

describe("parseProviderStreamSegment", () => {
  it("parses JSON payload inside data line", () => {
    expect(parseProviderStreamSegment('data: {"choices":[{"delta":{"content":"A"}}]}')).toEqual({
      replyDelta: "A",
      reasoningDelta: undefined,
      done: false,
    });
  });

  it("returns done for [DONE] segment", () => {
    expect(parseProviderStreamSegment("data: [DONE]")).toEqual({ done: true });
  });

  it("returns null for segments without data lines", () => {
    expect(parseProviderStreamSegment("event: message")).toBeNull();
  });

  it("throws for invalid JSON payload", () => {
    expect(() => parseProviderStreamSegment("data: {not-json}")).toThrow();
  });
});
