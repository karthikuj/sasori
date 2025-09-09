import { Page } from 'puppeteer';
import { DomPathInterface, PathStep } from '../types/dom';

/**
 * Internal Step class for path generation
 */
class Step implements PathStep {
    /**
     * The CSS or XPath step value
     */
    public readonly value: string;

    /**
     * Whether this step is optimized
     */
    public readonly optimized: boolean;

    /**
     * Step constructor
     * @param value - The step value
     * @param optimized - Whether this step is optimized
     */
    constructor(value: string, optimized: boolean = false) {
        this.value = value;
        this.optimized = optimized;
    }

    /**
     * String representation of the step
     * @returns The step value as a string
     */
    public toString(): string {
        return this.value;
    }
}

/**
 * The DomPath class is responsible for calculating all CSS paths and XPaths
 * for DOM elements in the context of a given page.
 */
export class DomPath implements DomPathInterface {
    /**
     * The Puppeteer page instance
     */
    public readonly page: Page;

    /**
     * DomPath object constructor.
     * @param page - The Puppeteer Page instance
     * @throws {Error} If page is not a valid Page instance
     */
    constructor(page: Page) {
        if (!page || typeof page.$$eval !== 'function') {
            throw new Error('Invalid Page instance provided to DomPath constructor');
        }
        this.page = page;
    }

    /**
     * This function returns an Array of CSS paths of the elements
     * in context of the given page.
     * @param cssPath - The CSS selector to find elements
     * @returns Promise that resolves to an array of CSS path strings
     * @throws {Error} If cssPath is not a valid string or if page evaluation fails
     */
    public async getCssPaths(cssPath: string): Promise<string[]> {
        if (typeof cssPath !== 'string' || cssPath.trim() === '') {
            throw new Error('cssPath must be a non-empty string');
        }

        try {
            return await this.page.$$eval(cssPath, (nodes: Element[]) => {
                return nodes.map((node: Element) => {
                    const Step = class {
                        /**
                         * @param value - The step value
                         * @param optimized - Whether this step is optimized
                         */
                        constructor(value: string, optimized: boolean = false) {
                            this.value = value;
                            this.optimized = optimized;
                        }

                        public readonly value: string;
                        public readonly optimized: boolean;

                        /**
                         * @override
                         * @returns The step value as a string
                         */
                        toString(): string {
                            return this.value;
                        }
                    };

                    const _cssPathStep = function (node: Element, optimized: boolean, isTargetNode: boolean): Step | null {
                        if (node.nodeType !== Node.ELEMENT_NODE) {
                            return null;
                        }

                        const id = node.getAttribute('id');
                        if (optimized) {
                            if (id) {
                                return new Step(idSelector(id), true);
                            }
                            const nodeNameLower = node.nodeName.toLowerCase();
                            if (nodeNameLower === 'body' || nodeNameLower === 'head' || nodeNameLower === 'html') {
                                return new Step(node.nodeName, true);
                            }
                        }
                        const nodeName = node.nodeName;

                        if (id) {
                            return new Step(nodeName + idSelector(id), true);
                        }
                        const parent = node.parentNode;
                        if (!parent || parent.nodeType === Node.DOCUMENT_NODE) {
                            return new Step(nodeName, true);
                        }

                        /**
                         * @param node - The DOM node
                         * @returns Array of prefixed class names
                         */
                        function prefixedElementClassNames(node: Element): string[] {
                            const classAttribute = node.getAttribute('class');
                            if (!classAttribute) {
                                return [];
                            }

                            return classAttribute.split(/\s+/g).filter(Boolean).map(function (name: string) {
                                // The prefix is required to store "__proto__" in a object-based map.
                                return '$' + name;
                            });
                        }

                        /**
                         * @param id - The element ID
                         * @returns CSS ID selector
                         */
                        function idSelector(id: string): string {
                            return '#' + (CSS?.escape ? CSS.escape(id) : id.replace(/[!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~]/g, '\\$&'));
                        }

                        const prefixedOwnClassNamesArray = prefixedElementClassNames(node);
                        let needsClassNames = false;
                        let needsNthChild = false;
                        let ownIndex = -1;
                        let elementIndex = -1;
                        const siblings = parent.children;
                        for (let i = 0; (ownIndex === -1 || !needsNthChild) && i < siblings.length; ++i) {
                            const sibling = siblings[i];
                            if (!sibling || sibling.nodeType !== Node.ELEMENT_NODE) {
                                continue;
                            }
                            elementIndex += 1;
                            if (sibling === node) {
                                ownIndex = elementIndex;
                                continue;
                            }
                            if (needsNthChild) {
                                continue;
                            }
                            if (sibling.nodeName !== nodeName) {
                                continue;
                            }

                            needsClassNames = true;
                            const ownClassNames = new Set(prefixedOwnClassNamesArray);
                            if (!ownClassNames.size) {
                                needsNthChild = true;
                                continue;
                            }
                            const siblingClassNamesArray = prefixedElementClassNames(sibling as Element);
                            for (let j = 0; j < siblingClassNamesArray.length; ++j) {
                                const siblingClass = siblingClassNamesArray[j];
                                if (!siblingClass || !ownClassNames.has(siblingClass)) {
                                    continue;
                                }
                                ownClassNames.delete(siblingClass);
                                if (!ownClassNames.size) {
                                    needsNthChild = true;
                                    break;
                                }
                            }
                        }

                        let result = nodeName;
                        if (isTargetNode && nodeName.toLowerCase() === 'input' && node.getAttribute('type') && !node.getAttribute('id') &&
                            !node.getAttribute('class')) {
                            const typeAttr = node.getAttribute('type');
                            if (typeAttr) {
                                result += '[type=' + CSS.escape(typeAttr) + ']';
                            }
                        }
                        if (needsNthChild) {
                            result += ':nth-child(' + (ownIndex + 1) + ')';
                        } else if (needsClassNames) {
                            for (const prefixedName of prefixedOwnClassNamesArray) {
                                const className = prefixedName.slice(1);
                                result += '.' + (CSS?.escape ? CSS.escape(className) : className.replace(/[!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~]/g, '\\$&'));
                            }
                        }

                        return new Step(result, false);
                    };

                    const cssPath = function (node: Element, optimized: boolean): string {
                        if (node.nodeType !== Node.ELEMENT_NODE) {
                            return '';
                        }

                        const steps: Step[] = [];
                        let contextNode: Element | null = node;
                        while (contextNode) {
                            const step = _cssPathStep(contextNode, !!optimized, contextNode === node);
                            if (!step) {
                                break;
                            } // Error - bail out early.
                            steps.push(step);
                            if (step.optimized) {
                                break;
                            }
                            contextNode = contextNode.parentNode;
                        }

                        steps.reverse();
                        return steps.join(' > ');
                    };

                    const fullQualifiedSelector = function (node: Element, justSelector: boolean): string {
                        if (node.nodeType !== Node.ELEMENT_NODE) {
                            return node.localName || node.nodeName.toLowerCase();
                        }
                        return cssPath(node, justSelector);
                    };

                    return fullQualifiedSelector(node, true);
                });
            });
        } catch (error) {
            console.error('Error getting CSS paths:', error);
            throw new Error(`Failed to get CSS paths: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * This function returns an Array of XPaths of the elements
     * in context of the given page.
     * @param cssPath - The CSS selector to find elements
     * @returns Promise that resolves to an array of XPath strings
     * @throws {Error} If cssPath is not a valid string or if page evaluation fails
     */
    public async getXPaths(cssPath: string): Promise<string[]> {
        if (typeof cssPath !== 'string' || cssPath.trim() === '') {
            throw new Error('cssPath must be a non-empty string');
        }

        try {
            return await this.page.$$eval(cssPath, (nodes: Element[]) => {
                return nodes.map((node: Element) => {
                    const Step = class {
                        /**
                         * @param value - The step value
                         * @param optimized - Whether this step is optimized
                         */
                        constructor(value: string, optimized: boolean = false) {
                            this.value = value;
                            this.optimized = optimized;
                        }

                        public readonly value: string;
                        public readonly optimized: boolean;

                        /**
                         * @override
                         * @returns The step value as a string
                         */
                        toString(): string {
                            return this.value;
                        }
                    };

                    const _xPathIndex = function (node: Element): number {
                        // Returns -1 in case of error, 0 if no siblings matching the same expression, <XPath index among the same expression-matching sibling nodes> otherwise.
                        /**
                         * Checks if the given Nodes are similar.
                         * @param left - First node to compare
                         * @param right - Second node to compare
                         * @returns True if nodes are similar
                         */
                        function areNodesSimilar(left: Node, right: Node): boolean {
                            if (left === right) {
                                return true;
                            }

                            if (left.nodeType === Node.ELEMENT_NODE && right.nodeType === Node.ELEMENT_NODE) {
                                return (left as Element).localName === (right as Element).localName;
                            }

                            if (left.nodeType === right.nodeType) {
                                return true;
                            }

                            // XPath treats CDATA as text nodes.
                            const leftType = left.nodeType === Node.CDATA_SECTION_NODE ? Node.TEXT_NODE : left.nodeType;
                            const rightType = right.nodeType === Node.CDATA_SECTION_NODE ? Node.TEXT_NODE : right.nodeType;
                            return leftType === rightType;
                        }

                        const siblings = node.parentNode ? node.parentNode.children : null;
                        if (!siblings) {
                            return 0;
                        } // Root node - no siblings.
                        let hasSameNamedElements = false;
                        for (let i = 0; i < siblings.length; ++i) {
                            if (areNodesSimilar(node, siblings[i] as Node) && siblings[i] !== node) {
                                hasSameNamedElements = true;
                                break;
                            }
                        }
                        if (!hasSameNamedElements) {
                            return 0;
                        }
                        let ownIndex = 1; // XPath indices start with 1.
                        for (let i = 0; i < siblings.length; ++i) {
                            if (areNodesSimilar(node, siblings[i] as Node)) {
                                if (siblings[i] === node) {
                                    return ownIndex;
                                }
                                ++ownIndex;
                            }
                        }
                        return -1; // An error occurred: |node| not found in parent's children.
                    };

                    const _xPathValue = function (node: Element, optimized: boolean): Step | null {
                        let ownValue: string;
                        const ownIndex = _xPathIndex(node);
                        if (ownIndex === -1) {
                            return null;
                        } // Error.

                        switch (node.nodeType) {
                            case Node.ELEMENT_NODE:
                                if (optimized && node.getAttribute('id')) {
                                    const idAttr = node.getAttribute('id');
                                    if (idAttr) {
                                        return new Step('//*[@id="' + idAttr + '"]', true);
                                    }
                                }
                                ownValue = node.localName || node.nodeName.toLowerCase();
                                break;
                            case Node.ATTRIBUTE_NODE:
                                ownValue = '@' + node.nodeName;
                                break;
                            case Node.TEXT_NODE:
                            case Node.CDATA_SECTION_NODE:
                                ownValue = 'text()';
                                break;
                            case Node.PROCESSING_INSTRUCTION_NODE:
                                ownValue = 'processing-instruction()';
                                break;
                            case Node.COMMENT_NODE:
                                ownValue = 'comment()';
                                break;
                            case Node.DOCUMENT_NODE:
                                ownValue = '';
                                break;
                            default:
                                ownValue = '';
                                break;
                        }

                        if (ownIndex > 0) {
                            ownValue += '[' + ownIndex + ']';
                        }

                        return new Step(ownValue, node.nodeType === Node.DOCUMENT_NODE);
                    };

                    const xPath = function (node: Element, optimized: boolean): string {
                        if (node.nodeType === Node.DOCUMENT_NODE) {
                            return '/';
                        }

                        const steps: Step[] = [];
                        let contextNode: Element | null = node;
                        while (contextNode) {
                            const step = _xPathValue(contextNode, optimized);
                            if (!step) {
                                break;
                            } // Error - bail out early.
                            steps.push(step);
                            if (step.optimized) {
                                break;
                            }
                            contextNode = contextNode.parentNode;
                        }

                        steps.reverse();
                        return (steps.length && steps[0]?.optimized ? '' : '/') + steps.join('/');
                    };

                    return xPath(node, true);
                });
            });
        } catch (error) {
            console.error('Error getting XPaths:', error);
            throw new Error(`Failed to get XPaths: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Validates if the page instance is still valid
     * @returns True if page is valid, false otherwise
     */
    public isPageValid(): boolean {
        try {
            return !!(this.page && typeof this.page.$$eval === 'function');
        } catch {
            return false;
        }
    }

    /**
     * Returns a string representation of the DomPath
     * @returns String representation of the DomPath instance
     */
    public toString(): string {
        return `DomPath(page: ${this.page ? 'valid' : 'invalid'})`;
    }
}

export default DomPath;
