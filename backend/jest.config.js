/** @type {import("jest").Config} **/
export default {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tests/tsconfig.test.json" }],
  },
  moduleNameMapper: {
    "^\\.\\./geometry\\.js$": "<rootDir>/src/services/geometry.ts",
    "^\\./polarViewObject\\.js$": "<rootDir>/src/services/scene/polarViewObject.ts",
    "^@/(.*)\\.js$": "<rootDir>/src/$1.ts",
  },
};
