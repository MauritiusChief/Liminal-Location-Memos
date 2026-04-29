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
  buildGameDebugRequestArtifacts,
  buildGameDebugResultArtifacts,
} from "../src/services/gameSystem/gameDebug";

describe("buildGameDebugRequestArtifacts", () => {
  it("builds user-message artifacts without a separate world-state file", () => {
    const artifacts = buildGameDebugRequestArtifacts({
      mode: "user-message",
      functionName: "gameStateManager",
      systemPrompt: "system prompt",
      userMessage: "玩家发送的消息\n---\nworld state",
    });

    expect(artifacts.map((artifact) => `${artifact.suffix}.${artifact.extension}`)).toEqual([
      "system.md",
      "user-message.md",
    ]);
    expect(artifacts.find((artifact) => artifact.suffix === "user-message")?.content).toContain("world state");
  });

  it("builds full-messages artifacts with synthetic tool call and masked tool return", () => {
    const artifacts = buildGameDebugRequestArtifacts({
      mode: "full-messages",
      functionName: "generateBookMessage",
      systemPrompt: "system prompt",
      gameMessages: [
        { role: "player", content: "向前看" },
        { role: "book", content: "你看到一条路" },
      ],
      statePrompt: "玩家周遭环境数据\n细节 A",
    });

    const snapshot = artifacts.find((artifact) => artifact.suffix === "full-messages")?.content ?? "";

    expect(artifacts.map((artifact) => `${artifact.suffix}.${artifact.extension}`)).toEqual([
      "system.md",
      "full-messages.md",
    ]);
    expect(snapshot).toContain("## 1. user");
    expect(snapshot).toContain("## 2. assistant");
    expect(snapshot).toContain("## 3. assistant");
    expect(snapshot).toContain("## 4. tool");
    expect(snapshot).toContain("\"name\": \"refresh_game_state\"");
    expect(snapshot).toContain("\"content\": \"\"");
    expect(snapshot).toContain("```md\n玩家周遭环境数据\n细节 A\n```");
  });
});

describe("buildGameDebugResultArtifacts", () => {
  it("builds text response and reasoning artifacts", () => {
    const artifacts = buildGameDebugResultArtifacts({
      functionName: "initialBookMessage",
      reply: "book reply",
      reasoning: "reasoning text",
    });

    expect(artifacts.map((artifact) => `${artifact.suffix}.${artifact.extension}`)).toEqual([
      "text-response.md",
      "reasoning.md",
    ]);
  });

  it("builds json response artifacts", () => {
    const artifacts = buildGameDebugResultArtifacts({
      functionName: "gameStateManager",
      reply: { ok: true },
    });

    expect(artifacts.map((artifact) => `${artifact.suffix}.${artifact.extension}`)).toEqual([
      "json-response.json",
    ]);
    expect(artifacts[0]?.content).toContain("\"ok\": true");
  });

  it("builds error artifacts", () => {
    const artifacts = buildGameDebugResultArtifacts({
      functionName: "generateBookMessage",
      error: new Error("boom"),
    });

    expect(artifacts.map((artifact) => `${artifact.suffix}.${artifact.extension}`)).toEqual([
      "error.md",
    ]);
    expect(artifacts[0]?.content).toContain("Error: boom");
  });
});
