module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src', '<rootDir>/tests', '<rootDir>/types'],
    testMatch: [
        '**/__tests__/**/*.ts',
        '**/?(*.)+(spec|test).ts'
    ],
    transform: {
        '^.+\\.ts$': ['ts-jest', {
            tsconfig: 'tsconfig.test.json'
        }],
    },
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
        '!src/**/__tests__/**',
    ],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov', 'html'],
    setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    // Puppeteer 25 and @puppeteer/replay 4 are ES modules only, which Jest's
    // CommonJS loader cannot load. Unit tests never launch a browser, so they
    // get CommonJS stand-ins with the same exports (see tests/stubs/).
    moduleNameMapper: {
        '^puppeteer$': '<rootDir>/tests/stubs/puppeteer.ts',
        '^@puppeteer/replay$': '<rootDir>/tests/stubs/puppeteer-replay.ts',
    },
    testTimeout: 10000,
};
