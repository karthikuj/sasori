import { randomUUID } from 'crypto';
class CrawlState {
    #stateId;

    constructor(url, dom, crawlDepth) {
        this.#stateId = randomUUID();
        this.url = url;
        this.dom = dom;
        this.crawlDepth = crawlDepth;
        this.crawlActions = [];
    }

    getStateId() {
        return this.#stateId;
    }

    getUrl() {
        return this.url;
    }

    getDom() {
        return this.dom;
    }

    getCrawlDepth() {
        return this.crawlDepth;
    }

    getCrawlActions() {
        return this.crawlActions;
    }

    setCrawlActions(crawlActions) {
        this.crawlActions = crawlActions;
    }

    // TODO:
    //     1. Add equals method to compare CrawlStates.
    //     2. Add getStrippedDom method.
}

export default CrawlState;