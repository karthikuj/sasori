// TODO:
    // 1. Create a scopeInsepector interceptor which will intercept requests 
        // and see if it is out-of-scope, if it is actually out-of-scope then
        // respond with something likt "Out of Sasori's scope".
    // 2. Create a JS file where all plugins will be registered, and then export an array
        // of JSON with the event name, handler and priority (for request/response events).
        // Priority should not clash, throw an error if it does.
    // 3. Now add the handlers by looping through them in crawler.js

class ScopeInspector {
    constructor() {
        if (this instanceof StaticClass) {
            throw Error('A static class cannot be instantiated.');
        }
    }
    static method() {}
}