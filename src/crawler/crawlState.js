class CrawlState {
    constructor(url, dom, parentState, crawlActions) {
        this.url = url;
        this.dom = dom;
        this.parentState = parentState;
        this.crawlActions = crawlActions;
    }

    // TODO:
    //     1. Add equals method to compare CrawlStates.
    //     2. Add getStrippedDom method.
    //     3. Add depth property.
    //     4. Add id to CrawlState.
}

module.exports = CrawlState;