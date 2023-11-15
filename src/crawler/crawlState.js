const crypto = require('crypto');

class CrawlState {
    constructor(url, dom, crawlDepth, crawlActions) {
        this.stateId = crypto.randomUUID();
        this.url = url;
        this.dom = dom;
        this.crawlDepth = crawlDepth;
        this.crawlActions = crawlActions;
    }

    // TODO:
    //     1. Add equals method to compare CrawlStates.
    //     2. Add getStrippedDom method.
}

module.exports = CrawlState;