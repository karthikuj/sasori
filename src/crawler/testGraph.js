const CrawlState = require('./crawlState');
const CrawlAction = require('./crawlAction');

class TestGraph {
    constructor() {
        const rootState = new CrawlState('https://www.example.com/rootState', '', 0);
        this.rootState = rootState;

        const de1 = new CrawlAction('a', 'click', 'de1 > a', rootState);
        const de2 = new CrawlAction('a', 'click', 'de2 > a', rootState);
        const de3 = new CrawlAction('a', 'click', 'de3 > a', rootState);
        rootState.setCrawlActions([de1, de2, de3]);

        const dv1 = new CrawlState('https://www.example.com/dv1', '', 1);
        const dv2 = new CrawlState('https://www.example.com/dv2', '', 1);
        const dv3 = new CrawlState('https://www.example.com/dv3', '', 1);
        de1.setChildState(dv1);
        de2.setChildState(dv2);
        de3.setChildState(dv3);

        const de4 = new CrawlAction('a', 'click', 'de4 > a', dv1);
        const de5 = new CrawlAction('a', 'click', 'de5 > a', dv1);
        const de6 = new CrawlAction('a', 'click', 'de6 > a', dv2);
        const de7 = new CrawlAction('a', 'click', 'de7 > a', dv2);
        const de8 = new CrawlAction('a', 'click', 'de8 > a', dv3);
        dv1.setCrawlActions([de4, de5]);
        dv2.setCrawlActions([de6, de7]);
        dv3.setCrawlActions([de8]);

        const dv4 = new CrawlState('https://www.example.com/dv4', '', 2);
        const dv5 = new CrawlState('https://www.example.com/dv5', '', 2);
        const dv6 = new CrawlState('https://www.example.com/dv6', '', 2);
        const dv7 = new CrawlState('https://www.example.com/dv7', '', 2);
        de4.setChildState(dv4);
        de5.setChildState(dv5);
        de6.setChildState(dv6);
        de7.setChildState(dv7);
        de8.setChildState(dv7);

        const de9 = new CrawlAction('a', 'click', 'de9 > a', dv4);
        const de10 = new CrawlAction('a', 'click', 'de10 > a', dv7);
        const de11 = new CrawlAction('a', 'click', 'de11 > a', dv7);
        const de12 = new CrawlAction('a', 'click', 'de12 > a', dv7);
        dv4.setCrawlActions([de9]);
        dv7.setCrawlActions([de10, de11, de12]);

        const dv8 = new CrawlState('https://www.example.com/dv8', '', 3);
        const dv9 = new CrawlState('https://www.example.com/dv9', '', 3);
        const dv10 = new CrawlState('https://www.example.com/dv10', '', 3);
        de9.setChildState(dv6);
        de10.setChildState(dv8);
        de11.setChildState(dv9);
        de12.setChildState(dv10);
    }

    getRoot() {
        return this.rootState;
    }
}

module.exports = TestGraph;