/**
 * The CrawlStateManager is responsible for creating and managing the crawl graph.
 */
class CrawlStateManager {
  /**
   * CrawlStateManager object constructor.
   * @param {CrawlState} rootState
   */
  constructor(rootState) {
    this.rootState = rootState;
  }

  /**
   * Returns CrawlState with the given stateHash if found else null.
   * @param {CrawlState} rootState
   * @param {CrawlState[]} visited
   * @param {string} stateHash
   * @return {CrawlState}
   */
  getStateByHash(rootState, visited, stateHash) {
    if (rootState.stateHash === stateHash) {
      return rootState;
    }
    for (const action of rootState.getCrawlActions()) {
      const childState = action.getChildState();

      if (!visited.includes(childState)) {
        visited.push(childState);
        return this.getStateByHash(childState, visited, stateHash);
      }
    }

    return null;
  }

  /**
   * Return the next crawlAction to be performed.
   * @param {CrawlState} rootState
   * @param {CrawlAction} lastAction
   * @param {boolean} lastActionFound
   * @param {CrawlAction[]} visited
   * @return {CrawlAction}
   */
  getNextCrawlAction(rootState, lastAction, lastActionFound, visited) {
    for (const action of rootState.getCrawlActions()) {
      if (lastAction === null || lastActionFound) {
        return action;
      }
      if (action === lastAction) {
        lastActionFound = true;
      }
      const childState = action.getChildState();

      if (!visited.includes(childState)) {
        visited.push(childState);
        return this.getNextCrawlAction(childState, lastAction, lastActionFound, visited);
      }
    }

    return null;
  }
}

export default CrawlStateManager;
