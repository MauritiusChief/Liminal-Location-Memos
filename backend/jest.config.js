/** @type {import("jest").Config} **/
export default {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tests/tsconfig.test.json" }],
  },
  moduleNameMapper: {
    "^\\.\\./overpassGeometry\\.js$": "<rootDir>/src/services/overpassGeometry.ts",
    "^@/(.*)\\.js$": "<rootDir>/src/$1.ts",
  },
};
