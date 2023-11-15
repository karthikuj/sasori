class CrawlAction {
    constructor(element, action, cssPath, parentState) {
        this.element = element;
        this.action = action;
        this.cssPath = cssPath;
        this.parentState = parentState;
        this.childState = null;

    }
}

// TODO:
//      1. Check if it is interactable. If not don't add it or remove it. Error:  Node is either not clickable or not an Element
//      2. Add getters and setters for properties.

module.exports = CrawlAction;