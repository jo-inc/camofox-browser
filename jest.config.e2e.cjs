module.exports = {
  transform: {},
  testEnvironment: 'node',
  testTimeout: 60000,

  // e2e tests run sequentially (shared browser state)
  maxWorkers: 1,

  testMatch: ['**/tests/e2e/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', 'live'],

  globalSetup: './tests/e2e/globalSetup.js',
  globalTeardown: './tests/e2e/globalTeardown.js',

  verbose: true,
  bail: 0,

  reporters: [
    'default',
    ...(process.env.CI ? [['jest-junit', { outputDirectory: 'test-results', outputName: 'e2e-results.xml' }]] : [])
  ]
};
