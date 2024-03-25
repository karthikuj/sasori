/**
 * The DomPath class is responsible for calculating all css paths and xpaths
 */
class DomPath {
  /**
   * DomPath object constructor.
   * @param {Page} page
   */
  constructor(page) {
    this.page = page;
  }

  /**
   * This function returns an Array of CssPaths of the elements
   * in context of the given page.
   * @param {String} cssPath
   * @return {Array<String>}
   */
  async getCssPaths(cssPath) {
    return await this.page.$$eval(cssPath, (nodes) => {
      return nodes.map((node) => {
        const Step = class {
          /**
           * @param {string} value
           * @param {boolean} optimized
           */
          constructor(value, optimized) {
            this.value = value;
            this.optimized = optimized || false;
          }

          /**
           * @override
           * @return {string}
           */
          toString() {
            return this.value;
          }
        };

        const _cssPathStep = function(node, optimized, isTargetNode) {
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
           * @param {Node} node
           * @return {!Array.<string>}
           */
          function prefixedElementClassNames(node) {
            const classAttribute = node.getAttribute('class');
            if (!classAttribute) {
              return [];
            }

            return classAttribute.split(/\s+/g).filter(Boolean).map(function(name) {
              // The prefix is required to store "__proto__" in a object-based map.
              return '$' + name;
            });
          }

          /**
           * @param {string} id
           * @return {string}
           */
          function idSelector(id) {
            return '#' + CSS.escape(id);
          }

          const prefixedOwnClassNamesArray = prefixedElementClassNames(node);
          let needsClassNames = false;
          let needsNthChild = false;
          let ownIndex = -1;
          let elementIndex = -1;
          const siblings = parent.children;
          for (let i = 0; (ownIndex === -1 || !needsNthChild) && i < siblings.length; ++i) {
            const sibling = siblings[i];
            if (sibling.nodeType !== Node.ELEMENT_NODE) {
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
            const siblingClassNamesArray = prefixedElementClassNames(sibling);
            for (let j = 0; j < siblingClassNamesArray.length; ++j) {
              const siblingClass = siblingClassNamesArray[j];
              if (!ownClassNames.has(siblingClass)) {
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
            result += '[type=' + CSS.escape(node.getAttribute('type')) + ']';
          }
          if (needsNthChild) {
            result += ':nth-child(' + (ownIndex + 1) + ')';
          } else if (needsClassNames) {
            for (const prefixedName of prefixedOwnClassNamesArray) {
              result += '.' + CSS.escape(prefixedName.slice(1));
            }
          }

          return new Step(result, false);
        };

        const cssPath = function(node, optimized) {
          if (node.nodeType !== Node.ELEMENT_NODE) {
            return '';
          }

          const steps = [];
          let contextNode = node;
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

        const fullQualifiedSelector = function(node, justSelector) {
          if (node.nodeType !== Node.ELEMENT_NODE) {
            return node.localName || node.nodeName.toLowerCase();
          }
          return cssPath(node, justSelector);
        };

        return fullQualifiedSelector(node, true);
      });
    });
  }

  /**
   * This function returns an Array of XPaths of the elements
   * in context of the given page.
   * @param {string} cssPath
   * @return {Array<String>}
   */
  async getXPaths(cssPath) {
    return await this.page.$$eval(cssPath, (nodes) => {
      return nodes.map((node) => {
        const Step = class {
          /**
           * @param {string} value
           * @param {boolean} optimized
           */
          constructor(value, optimized) {
            this.value = value;
            this.optimized = optimized || false;
          }

          /**
           * @override
           * @return {string}
           */
          toString() {
            return this.value;
          }
        };

        const _xPathIndex = function(node) {
          // Returns -1 in case of error, 0 if no siblings matching the same expression, <XPath index among the same expression-matching sibling nodes> otherwise.
          /**
           * Checks if the given Nodes are similar.
           * @param {Node} left
           * @param {Node} right
           * @return {boolean}
           */
          function areNodesSimilar(left, right) {
            if (left === right) {
              return true;
            }

            if (left.nodeType === Node.ELEMENT_NODE && right.nodeType === Node.ELEMENT_NODE) {
              return left.localName === right.localName;
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
          let hasSameNamedElements;
          for (let i = 0; i < siblings.length; ++i) {
            if (areNodesSimilar(node, siblings[i]) && siblings[i] !== node) {
              hasSameNamedElements = true;
              break;
            }
          }
          if (!hasSameNamedElements) {
            return 0;
          }
          let ownIndex = 1; // XPath indices start with 1.
          for (let i = 0; i < siblings.length; ++i) {
            if (areNodesSimilar(node, siblings[i])) {
              if (siblings[i] === node) {
                return ownIndex;
              }
              ++ownIndex;
            }
          }
          return -1; // An error occurred: |node| not found in parent's children.
        };

        const _xPathValue = function(node, optimized) {
          let ownValue;
          const ownIndex = _xPathIndex(node);
          if (ownIndex === -1) {
            return null;
          } // Error.

          switch (node.nodeType) {
            case Node.ELEMENT_NODE:
              if (optimized && node.getAttribute('id')) {
                return new Step('//*[@id="' + node.getAttribute('id') + '"]', true);
              }
              ownValue = node.localName;
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

        const xPath = function(node, optimized) {
          if (node.nodeType === Node.DOCUMENT_NODE) {
            return '/';
          }

          const steps = [];
          let contextNode = node;
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
          return (steps.length && steps[0].optimized ? '' : '/') + steps.join('/');
        };

        return xPath(node, true);
      });
    });
  }
}

module.exports = DomPath;
