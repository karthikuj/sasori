class CrawlState {
    constructor(url, dom, parentState, crawlActions) {
        this.url = url;
        this.dom = dom;
        this.parentState = parentState;
        this.crawlActions = crawlActions;
    }
}

module.exports = CrawlState;