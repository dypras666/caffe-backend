module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'routes/**/*.js',
    'middleware/**/*.js',
    '!node_modules/**'
  ],
  testMatch: [
    '**/__tests__/**/*.test.js'
  ],
  verbose: true,
  testTimeout: 15000,
  // Transform ESM-only packages to CommonJS for Jest
  transformIgnorePatterns: [
    'node_modules/(?!(expo-server-sdk)/)'
  ],
  // Mock ESM packages that Jest cannot transform
  moduleNameMapper: {
    '^expo-server-sdk$': '<rootDir>/__mocks__/expo-server-sdk.js',
  },
};
