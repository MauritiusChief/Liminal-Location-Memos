/// <reference types="jest" />

import { createSession } from "../src/services/gameSystem/gameSessionStore";

describe("gameSessionStore", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("creates a session with a normalized random player orientation", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.5);

    const session = await createSession();

    expect(session.playerOrientation).toBe(180);
    expect(session.playerOrientation).toBeGreaterThanOrEqual(0);
    expect(session.playerOrientation).toBeLessThan(360);
  });
});
