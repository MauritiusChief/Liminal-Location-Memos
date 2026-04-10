/// <reference types="jest" />

jest.mock("../src/config", () => ({
  config: {
    llmProvider: "openrouter",
    llmApiKey: "test-key",
    llmBaseUrl: "https://example.com",
    llmModel: "test-model",
  },
}));

import { normalizeProviderStreamPayload, parseProviderStreamSegment } from "../src/services/gameSystem/llm";

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
