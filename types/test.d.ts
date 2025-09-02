import { CrawlerConfig } from '../src/types';

declare global {
    var testUtils: {
        createValidConfig: () => CrawlerConfig;
    };

    namespace jest {
        interface Matchers<R> {
            toBeValidConfig(): R;
        }
    }
}

export { };
