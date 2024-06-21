/**
 * The CrawlStateManager is responsible for creating and managing the crawl graph.
 */
class CrawlStateManager {
  /**
   * CrawlStateManager object constructor.
   * @param {CrawlState} rootState
   */
  constructor(rootState) {
    this.rootState = rootState ? rootState : null;
    this.visitedActions = new Set();
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
   * @param {CrawlAction} lastAction
   * @return {CrawlAction}
   */
  getNextCrawlAction() {
    const stack = [...this.rootState.getCrawlActions()];
    const visited = new Set();

    while (stack.length) {
      const currentAction = stack.pop();
      const childState = currentAction.getChildState();

      if (!visited.has(currentAction.actionId)) {
        visited.add(currentAction.actionId);
        if (childState) {
          stack.push(...childState.getCrawlActions());
        } else {
          if (!this.visitedActions.has(currentAction.actionId)) {
            this.visitedActions.add(currentAction.actionId);
            return currentAction;
          }
        }
      }
    }

    return null;
  }

  /**
   * Returns false if CrawlAction with the same cssPath and actionHash is found else true.
   * @param {string} cssPath
   * @param {string} actionHash
   * @return {Boolean}
   */
  isCrawlActionUnique(cssPath, actionHash) {
    if (!this.rootState) {
      return true;
    }
    const stack = [...this.rootState.getCrawlActions()];
    const visited = new Set();

    while (stack.length) {
      const currentAction = stack.pop();
      const childState = currentAction.getChildState();

      if (!visited.has(currentAction.actionId)) {
        visited.add(currentAction.actionId);
        if (currentAction.cssPath === cssPath && currentAction.actionHash === actionHash) {
          return false;
        }
        if (childState) {
          stack.push(...childState.getCrawlActions());
        }
      }
    }

    return true;
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

module.exports = CrawlStateManager;
