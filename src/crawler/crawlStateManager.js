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
   * Traverse the state graph.
   * @param {CrawlState} rootState
   * @param {CrawlState[]} visited
   */
  traverse(rootState, visited) {
    console.log(rootState.url);
    for (const action of rootState.getCrawlActions()) {
      const childState = action.getChildState();

      if (childState && !visited.includes(childState)) {
        visited.push(childState);
        this.traverse(childState, visited);
      }
    }
  }

  /**
   * Returns CrawlState with the given stateHash if found else null.
   * @param {string} stateHash
   * @return {CrawlState}
   */
  getStateByHash(stateHash) {
    const stack = [this.rootState];
    const visited = new Set();

    while (stack.length) {
      const currentState = stack.pop();
      if (!visited.has(currentState.stateId)) {
        visited.add(currentState.stateId);
        if (currentState.stateHash === stateHash) {
          return currentState;
        }
        for (const action of currentState.getCrawlActions()) {
          const childState = action.getChildState();
          if (childState) {
            stack.push(childState);
          }
        }
      }
    }

    return null;
  }

  /**
   * Return the next crawlAction to be performed.
   * @param {CrawlState} rootState
   * @param {CrawlAction} lastAction
   * @return {CrawlAction}
   */
  getNextCrawlAction(rootState) {
    const stack = [rootState];
    const visited = new Set();

    while (stack.length) {
      const currentState = stack.pop();

      if (!visited.has(currentState.stateId)) {
        visited.add(currentState.stateId);
        console.log(`Current state url: ${currentState.url}`);

        for (const action of currentState.getCrawlActions()) {
          console.log(`Current action: ${action.cssPath}`);
          const childState = action.getChildState();
          if (childState) {
            console.log(`Child state found: ${childState.url}`);
            stack.push(childState);
          } else {
            console.log(`Child state not found.`);
            return action;
          }
        }
      }
    }

    return null;
  }

  /**
   * Returns the shortest path to a CrawlState from the root state.
   * @param {CrawlState} destinationState
   * @return {CrawlAction[]}
   */
  getShortestPath(destinationState) {
    const queue = [[this.rootState]];
    const visited = new Set();

    while (queue.length > 0) {
      const path = queue.shift();
      const currentState = path[path.length - 1];

      if (currentState === destinationState) {
        // Convert crawl states to crawl actions
        const crawlActionsPath = [];
        for (let i = 0; i < path.length - 1; i++) {
          const currentState = path[i];
          const nextState = path[i + 1];
          const action = currentState.crawlActions.find((action) => action.childState === nextState);
          crawlActionsPath.push(action);
        }
        return crawlActionsPath;
      }

      if (!visited.has(currentState.stateId)) {
        visited.add(currentState.stateId);

        for (const action of currentState.crawlActions) {
          const childState = action.childState;
          if (childState && !visited.has(childState.stateId)) {
            const newPath = [...path, childState];
            queue.push(newPath);
          }
        }
      }
    }

    return null;
  }
}

export default CrawlStateManager;
