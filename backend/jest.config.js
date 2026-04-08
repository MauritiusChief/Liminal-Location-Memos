/** @type {import("jest").Config} **/
export default {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tests/tsconfig.test.json" }],
  },
  moduleNameMapper: {
    "^\\.\\./geometry\\.js$": "<rootDir>/src/services/geometry.ts",
    "^\\.\\./scene/sceneObject\\.js$": "<rootDir>/src/services/scene/sceneObject.ts",
    "^\\.\\./scene/scenePrompt\\.js$": "<rootDir>/src/services/scene/scenePrompt.ts",
    "^\\./polarViewObject\\.js$": "<rootDir>/src/services/scene/polarViewObject.ts",
    "^\\./polarViewOcclusion\\.js$": "<rootDir>/src/services/scene/polarViewOcclusion.ts",
    "^\\./sceneUtilLabel\\.js$": "<rootDir>/src/services/scene/sceneUtilLabel.ts",
    "^\\./systemPrompts\\.js$": "<rootDir>/src/services/gameSystem/systemPrompts.ts",
    "^\\./gameDebug\\.js$": "<rootDir>/src/services/gameSystem/gameDebug.ts",
    "^\\./llm\\.js$": "<rootDir>/src/services/gameSystem/llm.ts",
    "^\\./gameSessionStore\\.js$": "<rootDir>/src/services/gameSystem/gameSessionStore.ts",
    "^@/(.*)\\.js$": "<rootDir>/src/$1.ts",
  },
};
