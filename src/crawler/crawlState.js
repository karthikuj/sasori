import { randomUUID } from 'crypto';

class CrawlState {
    constructor(url, dom, crawlDepth, crawlActions) {
        this.stateId = randomUUID();
        this.url = url;
        this.dom = dom;
        this.crawlDepth = crawlDepth;
        this.crawlActions = crawlActions;
    }

    // TODO:
    //     1. Add equals method to compare CrawlStates.
    //     2. Add getStrippedDom method.
}

export default CrawlState;