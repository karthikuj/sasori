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

      if (childState && !visited.includes(childState)) {
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
   * @return {CrawlAction}
   */
  getNextCrawlAction(rootState, lastAction) {
    const stack = [rootState];
    const visited = new Set();
    let lastActionFound = !lastAction;

    while (stack.length > 0) {
      const currentState = stack.pop();

      for (const action of currentState.getCrawlActions()) {
        console.log(action);
        if (lastActionFound) {
          return action;
        }
        if (action.actionId === lastAction.actionId) {
          console.log(`Last action found: ${action.actionId}`);
          lastActionFound = true;
        }
        const childState = action.getChildState();
        if (childState && !visited.has(childState.stateId)) {
          visited.add(childState.stateId);
          stack.push(childState);
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

    return null; // No path found
  }
}

export default CrawlStateManager;
