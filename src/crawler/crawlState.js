class CrawlState {
    constructor(url, dom, parentState) {
        this.url = url;
        this.dom = dom;
        this.parentState = parentState;
    }
}

module.exports = CrawlState;