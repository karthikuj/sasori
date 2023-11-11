class CrawlState {
    constructor(url, dom, interactableElements, parentState) {
        this.url = url;
        this.dom = dom;
        this.interactableElements = interactableElements || [];
        this.parentState = parentState;
    }
}

module.exports = CrawlState;