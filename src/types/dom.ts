import { Page } from 'puppeteer';

// DOM types for browser environment
declare global {
    interface Element {
        localName?: string;
        nodeName: string;
        nodeType: number;
        getAttribute(name: string): string | null;
    }

    interface Node {
        nodeType: number;
        localName?: string;
        nodeName: string;
        parentNode: Node | null;
    }
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
 * Node types for DOM manipulation
 */
export enum NodeType {
    ELEMENT_NODE = 1,
    TEXT_NODE = 3,
    COMMENT_NODE = 8,
}

/**
 * DOM manipulation utilities interface
 */
export interface DomUtilsInterface {
    stripDOM($: any): void;
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
