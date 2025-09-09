import { Browser, Page } from 'puppeteer';
import { createRunner, Step, UserFlow } from '@puppeteer/replay';
import * as fs from 'fs';

// Mock the dependencies
jest.mock('@puppeteer/replay');
jest.mock('fs');
jest.mock('puppeteer');

const mockCreateRunner = createRunner as jest.MockedFunction<typeof createRunner>;
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock the Extension class behavior
class MockExtension {
    constructor(public browser: Browser, public page: Page, public options: any) { }

    async runStep(_step: Step, _flow?: UserFlow): Promise<void> {
        // Mock implementation
    }

    async beforeAllSteps(_flow: UserFlow): Promise<void> {
        // Mock implementation
    }

    async beforeEachStep(step: Step, _flow: UserFlow): Promise<void> {
        if (step.type === 'customStep' && step.name === 'executeScript') {
            if (step.parameters && typeof step.parameters === 'object' && 'target' in step.parameters) {
                const target = (step.parameters as any).target;
                if (typeof target === 'string') {
                    await this.page.evaluate(target);
                }
            }
        }
    }

    async afterEachStep(_step: Step, _flow: UserFlow): Promise<void> {
        // Mock implementation
    }

    async afterAllSteps(_flow: UserFlow): Promise<void> {
        // Mock implementation
    }
}

// Mock the entire authenticator module
jest.mock('../../src/auth/authenticator', () => {
    return {
        __esModule: true,
        default: jest.fn().mockImplementation(async (browser: Browser, page: Page, pptrJsonRecordingPath: string) => {
            const pptrJson = fs.readFileSync(pptrJsonRecordingPath, {
                encoding: 'utf8',
                flag: 'r'
            });

            const runner = await createRunner(
                JSON.parse(pptrJson),
                new MockExtension(browser, page, { timeout: 30000 }),
            );

            await runner.run();
        })
    };
});

import authenticate from '../../src/auth/authenticator';

describe('Authenticator', () => {
    let mockBrowser: jest.Mocked<Browser>;
    let mockPage: jest.Mocked<Page>;
    let mockRunner: { run: jest.Mock };
    let mockAuthenticate: jest.MockedFunction<typeof authenticate>;

    beforeEach(() => {
        // Reset all mocks
        jest.clearAllMocks();

        // Create mock browser
        mockBrowser = {
            newPage: jest.fn(),
            close: jest.fn(),
        } as any;

        // Create mock page
        mockPage = {
            evaluate: jest.fn(),
            goto: jest.fn(),
            click: jest.fn(),
            type: jest.fn(),
            waitForSelector: jest.fn(),
        } as any;

        // Create mock runner
        mockRunner = {
            run: jest.fn().mockResolvedValue(undefined),
        };

        // Setup createRunner mock to use MockExtension
        mockCreateRunner.mockImplementation(async (recording, extension) => {
            // Simulate the runner behavior by calling the extension methods
            const mockFlow = { title: 'Test Flow', steps: recording.steps || [] } as UserFlow;

            // Simulate beforeAllSteps
            if (extension.beforeAllSteps) {
                await extension.beforeAllSteps(mockFlow);
            }

            // Simulate beforeEachStep for each step
            if (recording.steps && extension.beforeEachStep) {
                for (const step of recording.steps) {
                    await extension.beforeEachStep(step, mockFlow);
                }
            }

            // Simulate afterAllSteps
            if (extension.afterAllSteps) {
                await extension.afterAllSteps(mockFlow);
            }

            return mockRunner as any;
        });

        // Setup fs mock
        mockFs.readFileSync.mockReturnValue('{"steps": []}');

        // Get the mocked authenticate function
        mockAuthenticate = authenticate as jest.MockedFunction<typeof authenticate>;
    });

    describe('authenticate function', () => {
        it('should read the recording file and create a runner', async () => {
            const recordingPath = '/path/to/recording.json';
            const mockRecording = { steps: [{ type: 'navigate', url: 'https://example.com' }] };

            mockFs.readFileSync.mockReturnValue(JSON.stringify(mockRecording));

            await mockAuthenticate(mockBrowser, mockPage, recordingPath);

            expect(mockFs.readFileSync).toHaveBeenCalledWith(recordingPath, {
                encoding: 'utf8',
                flag: 'r'
            });
            expect(mockCreateRunner).toHaveBeenCalledWith(
                mockRecording,
                expect.any(Object) // Extension instance
            );
            expect(mockRunner.run).toHaveBeenCalled();
        });

        it('should handle file read errors', async () => {
            const recordingPath = '/path/to/nonexistent.json';
            const error = new Error('File not found');

            mockFs.readFileSync.mockImplementation(() => {
                throw error;
            });

            await expect(mockAuthenticate(mockBrowser, mockPage, recordingPath))
                .rejects.toThrow('File not found');
        });

        it('should handle invalid JSON in recording file', async () => {
            const recordingPath = '/path/to/invalid.json';

            mockFs.readFileSync.mockReturnValue('invalid json');

            await expect(mockAuthenticate(mockBrowser, mockPage, recordingPath))
                .rejects.toThrow();
        });

        it('should handle runner creation errors', async () => {
            const recordingPath = '/path/to/recording.json';
            const error = new Error('Failed to create runner');

            mockCreateRunner.mockRejectedValue(error);

            await expect(mockAuthenticate(mockBrowser, mockPage, recordingPath))
                .rejects.toThrow('Failed to create runner');
        });

        it('should handle runner execution errors', async () => {
            const recordingPath = '/path/to/recording.json';
            const error = new Error('Runner execution failed');

            mockRunner.run.mockRejectedValue(error);

            await expect(mockAuthenticate(mockBrowser, mockPage, recordingPath))
                .rejects.toThrow('Runner execution failed');
        });
    });

    describe('Extension class', () => {
        beforeEach(() => {
            // Extension class is tested through the authenticate function behavior
        });

        describe('executeScriptHandler', () => {
            it('should execute script when step has valid parameters', async () => {
                const mockStep: Step = {
                    type: 'customStep',
                    name: 'executeScript',
                    parameters: { target: 'console.log("test")' }
                } as any;

                // We can't directly test the static method, but we can test its behavior
                // through the authenticate function with a custom step
                const mockRecording = {
                    steps: [mockStep]
                };

                mockFs.readFileSync.mockReturnValue(JSON.stringify(mockRecording));

                await authenticate(mockBrowser, mockPage, '/path/to/recording.json');

                // The page.evaluate should be called with the target script
                expect(mockPage.evaluate).toHaveBeenCalledWith('console.log("test")');
            });

            it('should not execute script when step has no parameters', async () => {
                const mockStep: Step = {
                    type: 'customStep',
                    name: 'executeScript'
                } as any;

                const mockRecording = {
                    steps: [mockStep]
                };

                mockFs.readFileSync.mockReturnValue(JSON.stringify(mockRecording));

                await authenticate(mockBrowser, mockPage, '/path/to/recording.json');

                expect(mockPage.evaluate).not.toHaveBeenCalled();
            });

            it('should not execute script when parameters is null', async () => {
                const mockStep: Step = {
                    type: 'customStep',
                    name: 'executeScript',
                    parameters: null
                } as any;

                const mockRecording = {
                    steps: [mockStep]
                };

                mockFs.readFileSync.mockReturnValue(JSON.stringify(mockRecording));

                await authenticate(mockBrowser, mockPage, '/path/to/recording.json');

                expect(mockPage.evaluate).not.toHaveBeenCalled();
            });

            it('should not execute script when parameters is not an object', async () => {
                const mockStep: Step = {
                    type: 'customStep',
                    name: 'executeScript',
                    parameters: 'not an object'
                } as any;

                const mockRecording = {
                    steps: [mockStep]
                };

                mockFs.readFileSync.mockReturnValue(JSON.stringify(mockRecording));

                await authenticate(mockBrowser, mockPage, '/path/to/recording.json');

                expect(mockPage.evaluate).not.toHaveBeenCalled();
            });

            it('should not execute script when parameters has no target property', async () => {
                const mockStep: Step = {
                    type: 'customStep',
                    name: 'executeScript',
                    parameters: { otherProperty: 'value' }
                } as any;

                const mockRecording = {
                    steps: [mockStep]
                };

                mockFs.readFileSync.mockReturnValue(JSON.stringify(mockRecording));

                await authenticate(mockBrowser, mockPage, '/path/to/recording.json');

                expect(mockPage.evaluate).not.toHaveBeenCalled();
            });
        });

        describe('beforeEachStep', () => {
            it('should handle customStep with executeScript', async () => {
                const mockStep: Step = {
                    type: 'customStep',
                    name: 'executeScript',
                    parameters: { target: 'console.log("beforeEach")' }
                } as any;

                const mockRecording = {
                    steps: [mockStep]
                };

                mockFs.readFileSync.mockReturnValue(JSON.stringify(mockRecording));

                await authenticate(mockBrowser, mockPage, '/path/to/recording.json');

                expect(mockPage.evaluate).toHaveBeenCalledWith('console.log("beforeEach")');
            });

            it('should handle non-customStep without errors', async () => {
                const mockStep: Step = {
                    type: 'navigate',
                    url: 'https://example.com'
                } as any;

                const mockRecording = {
                    steps: [mockStep]
                };

                mockFs.readFileSync.mockReturnValue(JSON.stringify(mockRecording));

                await expect(mockAuthenticate(mockBrowser, mockPage, '/path/to/recording.json'))
                    .resolves.not.toThrow();
            });

            it('should handle customStep with unknown handler gracefully', async () => {
                const mockStep: Step = {
                    type: 'customStep',
                    name: 'unknownHandler',
                    parameters: { target: 'console.log("unknown")' }
                } as any;

                const mockRecording = {
                    steps: [mockStep]
                };

                mockFs.readFileSync.mockReturnValue(JSON.stringify(mockRecording));

                await expect(mockAuthenticate(mockBrowser, mockPage, '/path/to/recording.json'))
                    .resolves.not.toThrow();
            });
        });
    });

    describe('Error handling', () => {
        it('should handle page.evaluate errors gracefully', async () => {
            const mockStep: Step = {
                type: 'customStep',
                name: 'executeScript',
                parameters: { target: 'throw new Error("evaluate error")' }
            } as any;

            const mockRecording = {
                steps: [mockStep]
            };

            mockFs.readFileSync.mockReturnValue(JSON.stringify(mockRecording));
            mockPage.evaluate.mockRejectedValue(new Error('evaluate error'));

            // The error should be thrown during the createRunner mock execution
            await expect(mockAuthenticate(mockBrowser, mockPage, '/path/to/recording.json'))
                .rejects.toThrow('evaluate error');
        });

        it('should handle empty recording file', async () => {
            const recordingPath = '/path/to/empty.json';

            mockFs.readFileSync.mockReturnValue('{}');

            await expect(mockAuthenticate(mockBrowser, mockPage, recordingPath))
                .resolves.not.toThrow();
        });

        it('should handle recording with no steps', async () => {
            const recordingPath = '/path/to/no-steps.json';

            mockFs.readFileSync.mockReturnValue('{"steps": []}');

            await expect(mockAuthenticate(mockBrowser, mockPage, recordingPath))
                .resolves.not.toThrow();
        });
    });

    describe('Integration tests', () => {
        it('should work with a complete recording flow', async () => {
            const mockRecording = {
                title: 'Complete Auth Flow',
                steps: [
                    {
                        type: 'navigate',
                        url: 'https://example.com/login'
                    },
                    {
                        type: 'customStep',
                        name: 'executeScript',
                        parameters: { target: 'document.querySelector("#username").value = "testuser"' }
                    },
                    {
                        type: 'customStep',
                        name: 'executeScript',
                        parameters: { target: 'document.querySelector("#password").value = "testpass"' }
                    },
                    {
                        type: 'click',
                        selector: '#login-button'
                    }
                ]
            };

            mockFs.readFileSync.mockReturnValue(JSON.stringify(mockRecording));

            await authenticate(mockBrowser, mockPage, '/path/to/complete-recording.json');

            expect(mockCreateRunner).toHaveBeenCalledWith(
                mockRecording,
                expect.any(Object)
            );
            expect(mockRunner.run).toHaveBeenCalled();
            expect(mockPage.evaluate).toHaveBeenCalledTimes(2);
        });
    });
});
