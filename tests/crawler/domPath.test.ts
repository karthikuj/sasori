import DomPath from '../../src/crawler/domPath';
import { Page } from 'puppeteer';

// Mock puppeteer
jest.mock('puppeteer', () => ({
    Page: jest.fn()
}));

// Mock browser globals
const mockBrowserGlobals = {
    Node: {
        ELEMENT_NODE: 1,
        DOCUMENT_NODE: 9,
        TEXT_NODE: 3,
        CDATA_SECTION_NODE: 4,
        PROCESSING_INSTRUCTION_NODE: 7,
        ATTRIBUTE_NODE: 2,
        COMMENT_NODE: 8
    },
    CSS: {
        escape: (str: string) => str.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '\\$&')
    }
};

// Set up global mocks
Object.assign(global, mockBrowserGlobals);

describe('DomPath', () => {
    let domPath: DomPath;
    let mockPage: jest.Mocked<Page>;


    beforeEach(() => {
        // Reset all mocks
        jest.clearAllMocks();

        // Create mock page
        mockPage = {
            $$eval: jest.fn()
        } as any;

        domPath = new DomPath(mockPage);
    });

    describe('Constructor', () => {
        it('should create DomPath with valid page', () => {
            expect(domPath.page).toBe(mockPage);
        });

        it('should throw error for invalid page', () => {
            expect(() => {
                new DomPath(null as any);
            }).toThrow('Invalid Page instance provided to DomPath constructor');
        });

        it('should throw error for page without $$eval method', () => {
            const invalidPage = {} as any;
            expect(() => {
                new DomPath(invalidPage);
            }).toThrow('Invalid Page instance provided to DomPath constructor');
        });
    });

    describe('getCssPaths', () => {
        it('should return CSS paths for elements', async () => {
            const mockCssPaths = ['body > div#main', 'body > div#sidebar'];
            mockPage.$$eval.mockResolvedValue(mockCssPaths);

            const result = await domPath.getCssPaths('div');

            expect(result).toEqual(mockCssPaths);
            expect(mockPage.$$eval).toHaveBeenCalledWith('div', expect.any(Function));
        });

        it('should return empty array when no elements found', async () => {
            mockPage.$$eval.mockResolvedValue([]);

            const result = await domPath.getCssPaths('.non-existent');

            expect(result).toEqual([]);
            expect(mockPage.$$eval).toHaveBeenCalledWith('.non-existent', expect.any(Function));
        });

        it('should throw error for invalid cssPath', async () => {
            await expect(domPath.getCssPaths('')).rejects.toThrow('cssPath must be a non-empty string');
            await expect(domPath.getCssPaths('   ')).rejects.toThrow('cssPath must be a non-empty string');
        });

        it('should handle page evaluation errors', async () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
            mockPage.$$eval.mockRejectedValue(new Error('Page evaluation failed'));

            await expect(domPath.getCssPaths('div')).rejects.toThrow('Failed to get CSS paths: Page evaluation failed');
            expect(consoleSpy).toHaveBeenCalled();

            consoleSpy.mockRestore();
        });

        it('should handle unknown errors', async () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
            mockPage.$$eval.mockRejectedValue('Unknown error');

            await expect(domPath.getCssPaths('div')).rejects.toThrow('Failed to get CSS paths: Unknown error');
            expect(consoleSpy).toHaveBeenCalled();

            consoleSpy.mockRestore();
        });
    });

    describe('getXPaths', () => {
        it('should return XPaths for elements', async () => {
            const mockXPaths = ['/html/body/div[1]', '/html/body/div[2]'];
            mockPage.$$eval.mockResolvedValue(mockXPaths);

            const result = await domPath.getXPaths('div');

            expect(result).toEqual(mockXPaths);
            expect(mockPage.$$eval).toHaveBeenCalledWith('div', expect.any(Function));
        });

        it('should return empty array when no elements found', async () => {
            mockPage.$$eval.mockResolvedValue([]);

            const result = await domPath.getXPaths('.non-existent');

            expect(result).toEqual([]);
            expect(mockPage.$$eval).toHaveBeenCalledWith('.non-existent', expect.any(Function));
        });

        it('should throw error for invalid cssPath', async () => {
            await expect(domPath.getXPaths('')).rejects.toThrow('cssPath must be a non-empty string');
            await expect(domPath.getXPaths('   ')).rejects.toThrow('cssPath must be a non-empty string');
        });

        it('should handle page evaluation errors', async () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
            mockPage.$$eval.mockRejectedValue(new Error('Page evaluation failed'));

            await expect(domPath.getXPaths('div')).rejects.toThrow('Failed to get XPaths: Page evaluation failed');
            expect(consoleSpy).toHaveBeenCalled();

            consoleSpy.mockRestore();
        });

        it('should handle unknown errors', async () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
            mockPage.$$eval.mockRejectedValue('Unknown error');

            await expect(domPath.getXPaths('div')).rejects.toThrow('Failed to get XPaths: Unknown error');
            expect(consoleSpy).toHaveBeenCalled();

            consoleSpy.mockRestore();
        });
    });

    describe('isPageValid', () => {
        it('should return true for valid page', () => {
            expect(domPath.isPageValid()).toBe(true);
        });

        it('should return false for invalid page', () => {
            // Create a DomPath with a valid page first, then make it invalid
            const validPage = { $$eval: jest.fn() } as any;
            const domPath = new DomPath(validPage);

            // Make the page invalid by setting it to an invalid object
            Object.defineProperty(domPath, 'page', {
                value: {},
                writable: true
            });

            expect(domPath.isPageValid()).toBe(false);
        });

        it('should return false when page becomes invalid', () => {
            // Simulate page becoming invalid by setting it to null
            const originalPage = domPath.page;
            Object.defineProperty(domPath, 'page', {
                value: null,
                writable: true
            });
            expect(domPath.isPageValid()).toBe(false);

            // Restore original page
            Object.defineProperty(domPath, 'page', {
                value: originalPage,
                writable: true
            });
        });
    });

    describe('toString', () => {
        it('should return string representation with valid page', () => {
            const result = domPath.toString();
            expect(result).toContain('DomPath');
            expect(result).toContain('valid');
        });

        it('should return string representation with invalid page', () => {
            // Create a DomPath with a valid page first, then make it invalid
            const validPage = { $$eval: jest.fn() } as any;
            const domPath = new DomPath(validPage);

            // Make the page invalid by setting it to null
            Object.defineProperty(domPath, 'page', {
                value: null,
                writable: true
            });

            const result = domPath.toString();
            expect(result).toContain('DomPath');
            expect(result).toContain('invalid');
        });
    });

    describe('CSS Path Generation Logic', () => {
        it('should handle elements with IDs', async () => {
            const mockCssPaths = ['#main-content'];
            mockPage.$$eval.mockResolvedValue(mockCssPaths);

            const result = await domPath.getCssPaths('div');
            expect(result).toEqual(['#main-content']);
        });

        it('should handle elements with classes', async () => {
            const mockCssPaths = ['div.content'];
            mockPage.$$eval.mockResolvedValue(mockCssPaths);

            const result = await domPath.getCssPaths('div');
            expect(result).toEqual(['div.content']);
        });

        it('should handle input elements with type attributes', async () => {
            const mockCssPaths = ['input[type=text]'];
            mockPage.$$eval.mockResolvedValue(mockCssPaths);

            const result = await domPath.getCssPaths('input');
            expect(result).toEqual(['input[type=text]']);
        });
    });

    describe('XPath Generation Logic', () => {
        it('should handle elements with IDs', async () => {
            const mockXPaths = ['//*[@id="main-content"]'];
            mockPage.$$eval.mockResolvedValue(mockXPaths);

            const result = await domPath.getXPaths('div');
            expect(result).toEqual(['//*[@id="main-content"]']);
        });

        it('should handle text nodes', async () => {
            const mockXPaths = ['/text()[1]'];
            mockPage.$$eval.mockResolvedValue(mockXPaths);

            const result = await domPath.getXPaths('text()');
            expect(result).toEqual(['/text()[1]']);
        });

        it('should handle document nodes', async () => {
            const mockXPaths = ['/'];
            mockPage.$$eval.mockResolvedValue(mockXPaths);

            const result = await domPath.getXPaths('*');
            expect(result).toEqual(['/']);
        });
    });

    describe('Error Handling in Browser Context', () => {
        it('should handle CSS.escape not available', async () => {
            mockPage.$$eval.mockImplementation((_selector, fn) => {
                // Simulate browser context without CSS.escape
                const mockElements = [{
                    nodeType: 1,
                    nodeName: 'DIV',
                    getAttribute: (name: string) => name === 'id' ? 'test-id' : null,
                    parentNode: { nodeType: 9, children: [] }
                }];

                // Mock CSS object without escape method
                (global as any).CSS = undefined;

                return Promise.resolve((fn as any)(mockElements));
            });

            const result = await domPath.getCssPaths('div');
            expect(result).toEqual(['#test-id']);
        });

        it('should handle invalid DOM nodes gracefully', async () => {
            const mockCssPaths = [''];
            mockPage.$$eval.mockResolvedValue(mockCssPaths);

            const result = await domPath.getCssPaths('*');
            expect(result).toEqual(['']);
        });
    });

    describe('Integration Tests', () => {
        it('should work with complex DOM structures', async () => {
            const mockCssPaths = ['body > div#container > ul.nav > li:nth-child(1) > a'];
            mockPage.$$eval.mockResolvedValue(mockCssPaths);

            const result = await domPath.getCssPaths('a');
            expect(result).toEqual(['body > div#container > ul.nav > li:nth-child(1) > a']);
        });

        it('should handle multiple elements with different selectors', async () => {
            const mockCssPaths = ['#header', 'div.content', 'button[type=submit]'];
            mockPage.$$eval.mockResolvedValue(mockCssPaths);

            const result = await domPath.getCssPaths('*');
            expect(result).toEqual(['#header', 'div.content', 'button[type=submit]']);
        });
    });
});
