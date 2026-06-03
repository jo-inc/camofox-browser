module.exports = {
  // Disable transforms — we use native ESM via --experimental-vm-modules
  transform: {},
  testEnvironment: 'node',
  testTimeout: 60000, // 60 seconds per test
  
  // Run tests sequentially to avoid resource conflicts
  maxWorkers: 1,
  
  // Test file patterns
  testMatch: [
    '**/tests/**/*.test.js',
    '**/plugins/**/*.test.js',
    '**/scripts/**/*.test.js'
  ],
  
  // Ignore patterns
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/e2e/',
    '/tests/live/'
  ],
  
  // Setup and teardown
  globalSetup: undefined,
  globalTeardown: undefined,
  
  // Verbose output
  verbose: true,
  
  // Don't bail — run full suite even if a test fails
  bail: 0,
  
  // Coverage settings (optional)
  collectCoverage: false,
  coverageDirectory: 'coverage',
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/tests/'
  ],
  
  // Reporter settings
  reporters: [
    'default',
    ...(process.env.CI ? [['jest-junit', { outputDirectory: 'test-results' }]] : [])
  ]
};
