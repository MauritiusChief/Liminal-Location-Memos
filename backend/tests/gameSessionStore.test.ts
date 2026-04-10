/// <reference types="jest" />

import { createRuntimeSession } from "../src/services/gameSystem/gameSessionStore";

describe("gameSessionStore", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("creates a session with a normalized random player orientation", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.5);

    const session = await createRuntimeSession();

    expect(session.gameState.playerOrientation).toBe(180);
    expect(session.gameState.playerOrientation).toBeGreaterThanOrEqual(0);
    expect(session.gameState.playerOrientation).toBeLessThan(360);
    expect(session.runtime.pendingVisualDescription).toBe(false);
  });
});
