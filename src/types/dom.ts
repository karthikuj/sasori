import { Page } from 'puppeteer';

// `cheerio.CheerioAPI` below resolves through the ambient global namespace that
// the repo's legacy `@types/cheerio@0.22` declares, so no import is needed here —
// and adding one is an error, because it would be unused.

// DOM types for browser environment
declare global {
    interface Element extends Node {
        localName?: string;
        nodeName: string;
        nodeType: number;
        getAttribute(name: string): string | null;
        parentNode: Element | null;
    }

    interface Node {
        nodeType: number;
        localName?: string;
        nodeName: string;
        parentNode: Node | null;
        children: NodeListOf<Element>;
    }

    interface NodeListOf<T> {
        readonly length: number;
        item(index: number): T | null;
        [index: number]: T;
    }

    // CSS global object
    interface CSS {
        escape(ident: string): string;
    }

    const CSS: CSS;

    // Node constants
    const Node: {
        readonly ELEMENT_NODE: 1;
        readonly ATTRIBUTE_NODE: 2;
        readonly TEXT_NODE: 3;
        readonly CDATA_SECTION_NODE: 4;
        readonly PROCESSING_INSTRUCTION_NODE: 7;
        readonly COMMENT_NODE: 8;
        readonly DOCUMENT_NODE: 9;
    };

    // The globals below exist only inside `page.evaluate` callbacks, which run
    // in the browser rather than in Node. `tsconfig.json` deliberately omits the
    // `dom` lib — pulling it in would make every browser API look available to
    // server-side code, which is exactly the mistake this file exists to
    // prevent. Declaring the handful actually used keeps those callbacks typed
    // instead of reaching for `(globalThis as any)`.

    interface HTMLElement extends Element {
        click(): void;
    }

    interface Document {
        readyState: string;
        querySelector(selectors: string): Element | null;
        querySelectorAll(selectors: string): NodeListOf<Element>;
    }

    const document: Document;

    interface Screen {
        availWidth: number;
        availHeight: number;
    }

    const screen: Screen;
}

/**
 * DOM Path class interface for CSS and XPath generation
 */
export interface DomPathInterface {
    page: Page;
    getCssPaths(cssPath: string): Promise<string[]>;
    getXPaths(cssPath: string): Promise<string[]>;
}

/**
 * Step class for path generation
 */
export interface PathStep {
    value: string;
    optimized: boolean;
    toString(): string;
}


/**
 * DOM manipulation utilities interface
 */
export interface DomUtilsInterface {
    stripDOM($: cheerio.CheerioAPI): void;
    getElementSelector(element: Element): string;
    getXPathFromElement(element: Element): string;
}

/**
 * CSS selector generation interface
 */
export interface CssSelectorInterface {
    generateSelector(node: Node, optimized?: boolean): string;
    generateIdSelector(id: string): string;
    generateClassSelector(className: string): string;
}

/**
 * XPath generation interface
 */
export interface XPathInterface {
    generateXPath(node: Node, optimized?: boolean): string;
    getNodeIndex(node: Node): number;
    areNodesSimilar(left: Node, right: Node): boolean;
}
