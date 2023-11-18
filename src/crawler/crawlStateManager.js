// Keep a count of all states and vertices in the graph 
// by creating class static properties and incrementing them 
// every time a new one is added to the graph.
import TestGraph from './testGraph.js';

class CrawlStateManager {
    constructor(rootState) {
        this.rootState = rootState;
    }

    traverse(rootState, visited) {
        for (const action of rootState.getCrawlActions()) {
            const childState = action.getChildState();

            if (!visited.includes(childState)) {
                visited.push(childState);
                this.traverse(childState, visited);
            }
        }
    }
}

// const tg = new TestGraph();
// const csm = new CrawlStateManager(tg.getRoot());
// csm.traverse(csm.rootState, [csm.rootState]);