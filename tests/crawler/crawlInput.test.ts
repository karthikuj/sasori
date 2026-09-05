import CrawlInput from '../../src/crawler/crawlInput';
import { Page } from 'puppeteer';

// Mock crypto module
jest.mock('crypto', () => ({
    randomUUID: jest.fn(() => 'test-uuid-123')
}));

// Mock chalk
jest.mock('chalk', () => ({
    red: jest.fn((text: string) => text),
    yellow: jest.fn((text: string) => text),
}));

// Mock path
jest.mock('path', () => ({
    join: jest.fn((...args: string[]) => args.join('/')),
}));

describe('CrawlInput', () => {
    let mockParentState: any;
    let mockPage: jest.Mocked<Page>;

    beforeEach(() => {
        // Reset all mocks
        jest.clearAllMocks();

        // Create mock parent state
        mockParentState = {
            stateId: 'parent-state-123',
            url: 'https://example.com',
            stateHash: 'parent-hash',
            crawlDepth: 1,
            arrivalType: 'link',
            crawlInputs: [],
            crawlActions: [],
            getCrawlActions: jest.fn(() => []),
            getCrawlDepth: jest.fn(() => 1),
            getCrawlInputs: jest.fn(() => []),
            toString: jest.fn(() => 'CrawlState(https://example.com@depth:1)'),
            toJSON: jest.fn(() => ({}))
        };

        // Create mock page
        mockPage = {
            $eval: jest.fn(),
            $$eval: jest.fn(),
            waitForSelector: jest.fn(),
            select: jest.fn(),
        } as any;
    });

    describe('Static Properties', () => {
        it('should have INPUT_FIELDS constant', () => {
            expect(CrawlInput.INPUT_FIELDS).toBeDefined();
            expect(Array.isArray(CrawlInput.INPUT_FIELDS)).toBe(true);
            expect(CrawlInput.INPUT_FIELDS.length).toBeGreaterThan(0);
        });

        // SCAN-200 / SCAN-194 RC1: a bare <input> (no type attribute) is a text
        // field by default, but the explicit-type selectors miss it, so the
        // crawler used to never fill it — blocking form submission on required
        // bare inputs and skipping marker injection.
        it('discovers a bare <input> as a text field (discovery-only, not in INPUT_FIELDS)', () => {
            const bare = CrawlInput.DISCOVERY_ONLY_INPUT_FIELDS.find((f) => f.CSS_PATH === 'input:not([type])');
            expect(bare).toBeDefined();
            expect(bare!.ELEMENT).toBe('input');
            expect(bare!.TYPE).toBe('text');
            // Deliberately NOT in INPUT_FIELDS: that list feeds DomStripper, and
            // `input:not([type])` would match every type-stripped input there.
            expect(CrawlInput.INPUT_FIELDS.some((f) => f.CSS_PATH === 'input:not([type])')).toBe(false);
        });

        it('the bare-input selector matches a bare <input> but not typed or hidden ones', () => {
            const cheerio = require('cheerio');
            const $ = cheerio.load(
                '<form>' +
                '<input name="displayName">' +          // bare -> should match
                '<input type="text" name="a">' +         // explicit text -> its own selector
                '<input type="email" name="e">' +        // typed -> not bare
                '<input type="hidden" name="csrf">' +    // hidden -> must NOT be filled
                '</form>',
            );
            const matched = $('input:not([type])');
            expect(matched.length).toBe(1);
            expect(matched.attr('name')).toBe('displayName');
            // and the old explicit-text selector never matched the bare one — the gap.
            expect($('input[type="text"]').filter((_: number, el: unknown) => (el as { attribs: Record<string, string> }).attribs.name === 'displayName').length).toBe(0);
        });

        it('should have VALUES constant', () => {
            expect(CrawlInput.VALUES).toBeDefined();
            expect(CrawlInput.VALUES.inputText).toBe('Sasori');
            expect(CrawlInput.VALUES.inputEmail).toBe('sasori@hiddensand.bot');
            expect(CrawlInput.VALUES.inputPassword).toBe('sas0riOfTheH!dd3nSand');
            expect(CrawlInput.VALUES.inputSearch).toBe('Sasori');
            expect(CrawlInput.VALUES.inputUrl).toBe('https://www.hiddensand.bot/');
        });

        it('should have SUPPORTED_FILE_TYPES constant', () => {
            expect(CrawlInput.SUPPORTED_FILE_TYPES).toBeDefined();
            expect(typeof CrawlInput.SUPPORTED_FILE_TYPES).toBe('object');
            expect(CrawlInput.SUPPORTED_FILE_TYPES['image/png']).toEqual({ TYPE: 'image', EXTENSION: '.png' });
            expect(CrawlInput.SUPPORTED_FILE_TYPES['video/mp4']).toEqual({ TYPE: 'video', EXTENSION: '.mp4' });
        });

        it('should have INPUT_FIELDS as readonly', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = CrawlInput.INPUT_FIELDS;
            (CrawlInput as any).INPUT_FIELDS = [];
            expect(CrawlInput.INPUT_FIELDS).toEqual([]);
            // Restore original value
            (CrawlInput as any).INPUT_FIELDS = originalValue;
        });

        it('should have VALUES as readonly', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = CrawlInput.VALUES;
            (CrawlInput as any).VALUES = {};
            expect(CrawlInput.VALUES).toEqual({});
            // Restore original value
            (CrawlInput as any).VALUES = originalValue;
        });

        it('should have SUPPORTED_FILE_TYPES as readonly', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = CrawlInput.SUPPORTED_FILE_TYPES;
            (CrawlInput as any).SUPPORTED_FILE_TYPES = {};
            expect(CrawlInput.SUPPORTED_FILE_TYPES).toEqual({});
            // Restore original value
            (CrawlInput as any).SUPPORTED_FILE_TYPES = originalValue;
        });
    });

    describe('Constructor', () => {
        it('should create CrawlInput with valid parameters', () => {
            const crawlInput = new CrawlInput(
                'input',
                'text',
                'input[type="text"]',
                mockParentState
            );

            expect(crawlInput.inputId).toBe('test-uuid-123');
            expect(crawlInput.element).toBe('input');
            expect(crawlInput.type).toBe('text');
            expect(crawlInput.cssPath).toBe('input[type="text"]');
            expect(crawlInput.parentState).toBe(mockParentState);
        });

        it('should create CrawlInput with null type for textarea', () => {
            const crawlInput = new CrawlInput(
                'textarea',
                null,
                'textarea',
                mockParentState
            );

            expect(crawlInput.element).toBe('textarea');
            expect(crawlInput.type).toBeNull();
            expect(crawlInput.cssPath).toBe('textarea');
        });

        it('should create CrawlInput with null type for select', () => {
            const crawlInput = new CrawlInput(
                'select',
                null,
                'select',
                mockParentState
            );

            expect(crawlInput.element).toBe('select');
            expect(crawlInput.type).toBeNull();
            expect(crawlInput.cssPath).toBe('select');
        });

        it('should throw error for empty element', () => {
            expect(() => {
                new CrawlInput('' as any, 'text', 'input[type="text"]', mockParentState);
            }).toThrow('Element must be a non-empty string');
        });

        it('should throw error for null element', () => {
            expect(() => {
                new CrawlInput(null as any, 'text', 'input[type="text"]', mockParentState);
            }).toThrow('Element must be a non-empty string');
        });

        it('should throw error for undefined element', () => {
            expect(() => {
                new CrawlInput(undefined as any, 'text', 'input[type="text"]', mockParentState);
            }).toThrow('Element must be a non-empty string');
        });

        it('should throw error for whitespace-only element', () => {
            expect(() => {
                new CrawlInput('   ' as any, 'text', 'input[type="text"]', mockParentState);
            }).toThrow('Element must be a non-empty string');
        });

        it('should throw error for invalid element type', () => {
            expect(() => {
                new CrawlInput('div' as any, 'text', 'div', mockParentState);
            }).toThrow('Element must be one of: input, textarea, select');
        });

        it('should throw error for empty type when not null', () => {
            expect(() => {
                new CrawlInput('input', '' as any, 'input[type="text"]', mockParentState);
            }).toThrow('Type must be null or a non-empty string');
        });

        it('should throw error for whitespace-only type when not null', () => {
            expect(() => {
                new CrawlInput('input', '   ' as any, 'input[type="text"]', mockParentState);
            }).toThrow('Type must be null or a non-empty string');
        });

        it('should throw error for invalid input type', () => {
            expect(() => {
                new CrawlInput('input', 'invalid' as any, 'input[type="text"]', mockParentState);
            }).toThrow('Type must be one of: text, email, password, search, url, checkbox, radio, file');
        });

        it('should throw error for empty cssPath', () => {
            expect(() => {
                new CrawlInput('input', 'text', '', mockParentState);
            }).toThrow('CSS path must be a non-empty string');
        });

        it('should throw error for null cssPath', () => {
            expect(() => {
                new CrawlInput('input', 'text', null as any, mockParentState);
            }).toThrow('CSS path must be a non-empty string');
        });

        it('should throw error for undefined cssPath', () => {
            expect(() => {
                new CrawlInput('input', 'text', undefined as any, mockParentState);
            }).toThrow('CSS path must be a non-empty string');
        });

        it('should throw error for whitespace-only cssPath', () => {
            expect(() => {
                new CrawlInput('input', 'text', '   ', mockParentState);
            }).toThrow('CSS path must be a non-empty string');
        });

        it('should throw error for null parentState', () => {
            expect(() => {
                new CrawlInput('input', 'text', 'input[type="text"]', null as any);
            }).toThrow('Parent state is required');
        });

        it('should throw error for undefined parentState', () => {
            expect(() => {
                new CrawlInput('input', 'text', 'input[type="text"]', undefined as any);
            }).toThrow('Parent state is required');
        });
    });

    describe('Instance Methods', () => {
        let crawlInput: CrawlInput;

        beforeEach(() => {
            crawlInput = new CrawlInput(
                'input',
                'text',
                'input[type="text"]',
                mockParentState
            );
        });

        describe('getParentState', () => {
            it('should return the parent state', () => {
                expect(crawlInput.getParentState()).toBe(mockParentState);
            });

            it('should return the same parent state reference', () => {
                const parentState = crawlInput.getParentState();
                expect(parentState).toBe(mockParentState);
                expect(parentState.stateId).toBe('parent-state-123');
            });
        });

        describe('getFilePath', () => {
            it('should return default file path when accept attribute is null', async () => {
                mockPage.$eval.mockResolvedValue(null);

                const result = await crawlInput.getFilePath(mockPage, 'input[type="file"]');

                expect(result).toBe('resources/uploadFiles/image/sasori.png');
                expect(mockPage.$eval).toHaveBeenCalledWith('input[type="file"]', expect.any(Function));
            });

            it('should return specific file path for supported image type', async () => {
                mockPage.$eval.mockResolvedValue('image/png');

                const result = await crawlInput.getFilePath(mockPage, 'input[type="file"]');

                expect(result).toBe('resources/uploadFiles/image/sasori.png');
            });

            it('should return specific file path for supported video type', async () => {
                mockPage.$eval.mockResolvedValue('video/mp4');

                const result = await crawlInput.getFilePath(mockPage, 'input[type="file"]');

                expect(result).toBe('resources/uploadFiles/video/sasori.mp4');
            });

            it('should return specific file path for supported audio type', async () => {
                mockPage.$eval.mockResolvedValue('audio/mp3');

                const result = await crawlInput.getFilePath(mockPage, 'input[type="file"]');

                expect(result).toBe('resources/uploadFiles/audio/sasori.mp3');
            });

            it('should return specific file path for supported application type', async () => {
                mockPage.$eval.mockResolvedValue('application/pdf');

                const result = await crawlInput.getFilePath(mockPage, 'input[type="file"]');

                expect(result).toBe('resources/uploadFiles/application/sasori.pdf');
            });

            it('should return specific file path for supported text type', async () => {
                mockPage.$eval.mockResolvedValue('text/plain');

                const result = await crawlInput.getFilePath(mockPage, 'input[type="file"]');

                expect(result).toBe('resources/uploadFiles/text/sasori.txt');
            });

            it('should handle multiple accepted types and return first match', async () => {
                mockPage.$eval.mockResolvedValue('image/png,video/mp4,audio/mp3');

                const result = await crawlInput.getFilePath(mockPage, 'input[type="file"]');

                expect(result).toBe('resources/uploadFiles/image/sasori.png');
            });

            it('should return default file path for unsupported type', async () => {
                mockPage.$eval.mockResolvedValue('unsupported/type');

                const result = await crawlInput.getFilePath(mockPage, 'input[type="file"]');

                expect(result).toBe('resources/uploadFiles/image/sasori.png');
            });

            it('should handle errors and return default file path', async () => {
                mockPage.$eval.mockRejectedValue(new Error('Element not found'));

                const result = await crawlInput.getFilePath(mockPage, 'input[type="file"]');

                expect(result).toBe('resources/uploadFiles/image/sasori.png');
            });
        });

        describe('inputFieldHandler', () => {
            it('should call inputHandler for input element', async () => {
                const inputHandlerSpy = jest.spyOn(crawlInput, 'inputHandler').mockResolvedValue();

                await crawlInput.inputFieldHandler(mockPage);

                expect(inputHandlerSpy).toHaveBeenCalledWith(mockPage);
            });

            it('should call textareaHandler for textarea element', async () => {
                const textareaInput = new CrawlInput('textarea', null, 'textarea', mockParentState);
                const textareaHandlerSpy = jest.spyOn(textareaInput, 'textareaHandler').mockResolvedValue();

                await textareaInput.inputFieldHandler(mockPage);

                expect(textareaHandlerSpy).toHaveBeenCalledWith(mockPage);
            });

            it('should call selectHandler for select element', async () => {
                const selectInput = new CrawlInput('select', null, 'select', mockParentState);
                const selectHandlerSpy = jest.spyOn(selectInput, 'selectHandler').mockResolvedValue();

                await selectInput.inputFieldHandler(mockPage);

                expect(selectHandlerSpy).toHaveBeenCalledWith(mockPage);
            });
        });

        describe('inputHandler', () => {
            let mockNode: any;

            beforeEach(() => {
                mockNode = {
                    type: jest.fn(),
                    click: jest.fn(),
                    uploadFile: jest.fn(),
                    focus: jest.fn(),
                    // replaceValue selects the field's existing value before
                    // typing; the callback runs against a real DOM node in the
                    // browser, so here we just run it against a stub exposing
                    // select() to prove the clear path executes.
                    evaluate: jest.fn(async (fn: (el: unknown) => unknown) => fn({ select: jest.fn() })),
                };
                mockPage.waitForSelector.mockResolvedValue(mockNode);
            });

            it('should handle text input', async () => {
                const textInput = new CrawlInput('input', 'text', 'input[type="text"]', mockParentState);

                await textInput.inputHandler(mockPage);

                expect(mockNode.type).toHaveBeenCalledWith('Sasori');
            });

            it('clears a prefilled field before typing (focus + select, then type)', async () => {
                // Regression for SCAN-201: appending to a prefilled email produced
                // an invalid `a@b c@d` value that blocked the whole form's submit.
                const emailInput = new CrawlInput('input', 'email', 'input[type="email"]', mockParentState);

                await emailInput.inputHandler(mockPage);

                expect(mockNode.focus).toHaveBeenCalled();
                expect(mockNode.evaluate).toHaveBeenCalled();
                // The clear (focus + select) must happen before the value is typed.
                const focusOrder = mockNode.focus.mock.invocationCallOrder[0];
                const typeOrder = mockNode.type.mock.invocationCallOrder[0];
                expect(focusOrder).toBeLessThan(typeOrder);
                expect(mockNode.type).toHaveBeenCalledWith('sasori@hiddensand.bot');
            });

            it('should handle email input', async () => {
                const emailInput = new CrawlInput('input', 'email', 'input[type="email"]', mockParentState);

                await emailInput.inputHandler(mockPage);

                expect(mockNode.type).toHaveBeenCalledWith('sasori@hiddensand.bot');
            });

            it('should handle password input', async () => {
                const passwordInput = new CrawlInput('input', 'password', 'input[type="password"]', mockParentState);

                await passwordInput.inputHandler(mockPage);

                expect(mockNode.type).toHaveBeenCalledWith('sas0riOfTheH!dd3nSand');
            });

            it('should handle search input', async () => {
                const searchInput = new CrawlInput('input', 'search', 'input[type="search"]', mockParentState);

                await searchInput.inputHandler(mockPage);

                expect(mockNode.type).toHaveBeenCalledWith('Sasori');
            });

            it('should handle url input', async () => {
                const urlInput = new CrawlInput('input', 'url', 'input[type="url"]', mockParentState);

                await urlInput.inputHandler(mockPage);

                expect(mockNode.type).toHaveBeenCalledWith('https://www.hiddensand.bot/');
            });

            it('should handle checkbox input', async () => {
                const checkboxInput = new CrawlInput('input', 'checkbox', 'input[type="checkbox"]', mockParentState);

                await checkboxInput.inputHandler(mockPage);

                expect(mockNode.click).toHaveBeenCalled();
            });

            it('should handle radio input', async () => {
                const radioInput = new CrawlInput('input', 'radio', 'input[type="radio"]', mockParentState);

                await radioInput.inputHandler(mockPage);

                expect(mockNode.click).toHaveBeenCalled();
            });

            it('should handle file input', async () => {
                const fileInput = new CrawlInput('input', 'file', 'input[type="file"]', mockParentState);
                jest.spyOn(fileInput, 'getFilePath').mockResolvedValue('test-file.png');

                await fileInput.inputHandler(mockPage);

                expect(fileInput.getFilePath).toHaveBeenCalledWith(mockPage, 'input[type="file"]');
                expect(mockNode.uploadFile).toHaveBeenCalledWith('test-file.png');
            });

            it('should handle selector not found error', async () => {
                mockPage.waitForSelector.mockRejectedValue(new Error('Element not found'));

                await crawlInput.inputHandler(mockPage);

                expect(mockNode.type).not.toHaveBeenCalled();
            });

            it('should handle node not found', async () => {
                mockPage.waitForSelector.mockResolvedValue(null);

                await crawlInput.inputHandler(mockPage);

                expect(mockNode.type).not.toHaveBeenCalled();
            });
        });

        describe('textareaHandler', () => {
            let mockNode: any;

            beforeEach(() => {
                mockNode = {
                    type: jest.fn(),
                    focus: jest.fn(),
                    evaluate: jest.fn(async (fn: (el: unknown) => unknown) => fn({ select: jest.fn() })),
                };
                mockPage.waitForSelector.mockResolvedValue(mockNode);
            });

            it('should type text in textarea', async () => {
                const textareaInput = new CrawlInput('textarea', null, 'textarea', mockParentState);

                await textareaInput.textareaHandler(mockPage);

                expect(mockNode.type).toHaveBeenCalledWith('Sasori');
            });

            it('clears a prefilled textarea before typing (SCAN-201)', async () => {
                const textareaInput = new CrawlInput('textarea', null, 'textarea', mockParentState);

                await textareaInput.textareaHandler(mockPage);

                expect(mockNode.focus).toHaveBeenCalled();
                expect(mockNode.focus.mock.invocationCallOrder[0]).toBeLessThan(mockNode.type.mock.invocationCallOrder[0]);
            });

            it('should handle selector not found error', async () => {
                mockPage.waitForSelector.mockRejectedValue(new Error('Element not found'));

                await crawlInput.textareaHandler(mockPage);

                expect(mockNode.type).not.toHaveBeenCalled();
            });

            it('should handle node not found', async () => {
                mockPage.waitForSelector.mockResolvedValue(null);

                await crawlInput.textareaHandler(mockPage);

                expect(mockNode.type).not.toHaveBeenCalled();
            });
        });

        describe('selectHandler', () => {
            let mockNode: any;

            beforeEach(() => {
                mockNode = {
                    $$eval: jest.fn(),
                };
                mockPage.waitForSelector.mockResolvedValue(mockNode);
            });

            it('should select first non-empty option', async () => {
                mockNode.$$eval.mockResolvedValue('option1');

                await crawlInput.selectHandler(mockPage);

                expect(mockPage.select).toHaveBeenCalledWith('input[type="text"]', 'option1');
            });

            it('should handle no valid options', async () => {
                mockNode.$$eval.mockResolvedValue(null);

                await crawlInput.selectHandler(mockPage);

                expect(mockPage.select).not.toHaveBeenCalled();
            });

            it('should handle selector not found error', async () => {
                mockPage.waitForSelector.mockRejectedValue(new Error('Element not found'));

                await crawlInput.selectHandler(mockPage);

                expect(mockPage.select).not.toHaveBeenCalled();
            });

            it('should handle node not found', async () => {
                mockPage.waitForSelector.mockResolvedValue(null);

                await crawlInput.selectHandler(mockPage);

                expect(mockPage.select).not.toHaveBeenCalled();
            });
        });
    });

    describe('Utility Methods', () => {
        let crawlInput: CrawlInput;

        beforeEach(() => {
            crawlInput = new CrawlInput(
                'input',
                'text',
                'input[type="text"]',
                mockParentState
            );
        });

        describe('toString', () => {
            it('should return string representation', () => {
                const result = crawlInput.toString();
                expect(result).toBe('CrawlInput(input:text@input[type="text"])');
            });

            it('should include all key properties in string representation', () => {
                const result = crawlInput.toString();
                expect(result).toContain('input');
                expect(result).toContain('text');
                expect(result).toContain('input[type="text"]');
            });

            it('should work with null type', () => {
                const textareaInput = new CrawlInput('textarea', null, 'textarea', mockParentState);
                expect(textareaInput.toString()).toBe('CrawlInput(textarea:null@textarea)');
            });
        });

        describe('toJSON', () => {
            it('should return JSON representation', () => {
                const result = crawlInput.toJSON();

                expect(result).toEqual({
                    inputId: 'test-uuid-123',
                    element: 'input',
                    type: 'text',
                    cssPath: 'input[type="text"]',
                    parentState: mockParentState,
                });
            });

            it('should return a new object each time', () => {
                const json1 = crawlInput.toJSON();
                const json2 = crawlInput.toJSON();

                expect(json1).toEqual(json2);
                expect(json1).not.toBe(json2); // Different object references
            });
        });
    });

    describe('Property Immutability', () => {
        let crawlInput: CrawlInput;

        beforeEach(() => {
            crawlInput = new CrawlInput(
                'input',
                'text',
                'input[type="text"]',
                mockParentState
            );
        });

        it('should have readonly inputId (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlInput.inputId;
            (crawlInput as any).inputId = 'new-id';
            expect(crawlInput.inputId).toBe('new-id');
            // Restore original value
            (crawlInput as any).inputId = originalValue;
        });

        it('should have readonly element (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlInput.element;
            (crawlInput as any).element = 'textarea';
            expect(crawlInput.element).toBe('textarea');
            // Restore original value
            (crawlInput as any).element = originalValue;
        });

        it('should have readonly type (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlInput.type;
            (crawlInput as any).type = 'email';
            expect(crawlInput.type).toBe('email');
            // Restore original value
            (crawlInput as any).type = originalValue;
        });

        it('should have readonly cssPath (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlInput.cssPath;
            (crawlInput as any).cssPath = 'new-path';
            expect(crawlInput.cssPath).toBe('new-path');
            // Restore original value
            (crawlInput as any).cssPath = originalValue;
        });

        it('should have readonly parentState (compile-time only)', () => {
            // TypeScript readonly is compile-time only, not runtime protected
            const originalValue = crawlInput.parentState;
            (crawlInput as any).parentState = {};
            expect(crawlInput.parentState).toEqual({});
            // Restore original value
            (crawlInput as any).parentState = originalValue;
        });
    });

    describe('Edge Cases', () => {
        it('should handle whitespace-only strings as invalid', () => {
            expect(() => {
                new CrawlInput('   ' as any, 'text', 'input[type="text"]', mockParentState);
            }).toThrow('Element must be a non-empty string');
        });

        it('should handle very long strings', () => {
            const longString = 'a'.repeat(1000);
            const longCssPath = '#'.repeat(1000);

            expect(() => {
                new CrawlInput(longString as any, 'text', longCssPath, mockParentState);
            }).toThrow('Element must be one of: input, textarea, select');
        });

        it('should handle special characters in strings', () => {
            const specialCssPath = '#form > div:nth-child(2) > input[type="email"]';

            expect(() => {
                new CrawlInput('input', 'text', specialCssPath, mockParentState);
            }).not.toThrow();
        });

        it('should handle unicode characters', () => {
            const unicodeCssPath = '#按钮';

            expect(() => {
                new CrawlInput('input', 'text', unicodeCssPath, mockParentState);
            }).not.toThrow();
        });
    });

    describe('Integration Tests', () => {
        it('should work with realistic crawler scenario', () => {
            const parentState = {
                stateId: 'homepage-state',
                url: 'https://example.com',
                stateHash: 'homepage-hash',
                crawlDepth: 0,
                arrivalType: 'link' as const,
                crawlInputs: [],
                crawlActions: [],
                getCrawlActions: jest.fn(() => []),
                getCrawlDepth: jest.fn(() => 0),
                getCrawlInputs: jest.fn(() => []),
                toString: jest.fn(() => 'CrawlState(https://example.com@depth:0)'),
                toJSON: jest.fn(() => ({}))
            };

            const crawlInput = new CrawlInput(
                'input',
                'email',
                'input[type="email"]',
                parentState
            );

            expect(crawlInput.element).toBe('input');
            expect(crawlInput.type).toBe('email');
            expect(crawlInput.cssPath).toBe('input[type="email"]');
            expect(crawlInput.getParentState()).toBe(parentState);
        });

        it('should maintain state consistency across operations', () => {
            const crawlInput = new CrawlInput(
                'textarea',
                null,
                '#message',
                mockParentState
            );

            // Test getters return consistent data
            expect(crawlInput.getParentState()).toBe(crawlInput.parentState);

            // Test JSON representation includes all data
            const json = crawlInput.toJSON();
            expect(json.element).toBe(crawlInput.element);
            expect(json.type).toBe(crawlInput.type);
            expect(json.cssPath).toBe(crawlInput.cssPath);
            expect(json.parentState).toBe(crawlInput.parentState);
        });
    });
});
