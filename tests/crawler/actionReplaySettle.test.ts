import { ActionReplay } from '../../src/crawler/actionReplay';
import CrawlState from '../../src/crawler/crawlState';
import CrawlAction from '../../src/crawler/crawlAction';
import type { CrawlerSettings } from '../../src/types/crawler';

let idCounter = 0;
jest.mock('crypto', () => ({
    ...jest.requireActual('crypto'),
    randomUUID: jest.fn(() => `id-${++idCounter}`),
}));

function settings(eventWait: number): CrawlerSettings {
    return {
        entryPoint: 'http://x/',
        eventTimeout: 1000,
        navigationTimeout: 3000,
        eventWait,
        maxDuration: 0,
        elements: ['a'],
        maxChildren: 0,
        maxDepth: 5,
        authentication: { basicAuth: { enabled: false, username: '', password: '' }, recorderAuth: { enabled: false, pptrRecording: '' } },
        includeRegexes: ['.*'],
        excludeRegexes: [],
    };
}

// Minimal mock Page covering only what performAction touches on the no-replay
// happy path.
function mockPage(): { page: any; waitForNetworkIdle: jest.Mock; evaluate: jest.Mock; node: any } {
    const node = { click: jest.fn().mockResolvedValue(undefined) };
    const waitForNetworkIdle = jest.fn().mockResolvedValue(undefined);
    const evaluate = jest.fn().mockResolvedValue(undefined); // the DOM-quiet arm
    const page = {
        url: jest.fn().mockReturnValue('http://x/account'),
        waitForSelector: jest.fn().mockResolvedValue(node),
        waitForNetworkIdle,
        evaluate,
    };
    return { page, waitForNetworkIdle, evaluate, node };
}

describe('ActionReplay settle-after-action (SCAN-198)', () => {
    beforeEach(() => {
        idCounter = 0;
    });

    it('settles (DOM-quiet raced with network-idle) after the action click', async () => {
        const parent = new CrawlState('http://x/account', 'hash-account', 0, 'link');
        const action = new CrawlAction(CrawlAction.ANCHOR, 'click', 'BODY > MAIN > A', 'h', parent);
        const { page, waitForNetworkIdle, evaluate, node } = mockPage();

        // hashPage returns the parent's hash → no replay; go straight to phase 2.
        const replay = new ActionReplay(settings(0), async () => 'hash-account', () => undefined);
        const crawlManager = {} as any;

        await replay.performAction(crawlManager, action, page as any);

        expect(page.waitForSelector).toHaveBeenCalledWith('BODY > MAIN > A');
        expect(node.click).toHaveBeenCalled();
        // The fix settles before returning: a DOM-quiet wait (page.evaluate) raced
        // with a bounded network-idle wait.
        expect(evaluate).toHaveBeenCalledTimes(1);
        expect(waitForNetworkIdle).toHaveBeenCalledTimes(1);
        expect(waitForNetworkIdle).toHaveBeenCalledWith(expect.objectContaining({ timeout: 3000 }));
    });

    it('still settles even when a configured eventWait pause is added', async () => {
        const parent = new CrawlState('http://x/account', 'hash-account', 0, 'link');
        const action = new CrawlAction(CrawlAction.ANCHOR, 'click', 'BODY > A', 'h', parent);
        const { page, waitForNetworkIdle } = mockPage();

        const replay = new ActionReplay(settings(5), async () => 'hash-account', () => undefined);
        await replay.performAction({} as any, action, page as any);

        expect(waitForNetworkIdle).toHaveBeenCalledTimes(1);
    });

    it('swallows a settle failure (both arms rejecting) rather than throwing', async () => {
        const parent = new CrawlState('http://x/account', 'hash-account', 0, 'link');
        const action = new CrawlAction(CrawlAction.ANCHOR, 'click', 'BODY > A', 'h', parent);
        const { page } = mockPage();
        page.waitForNetworkIdle = jest.fn().mockRejectedValue(new Error('idle timeout'));
        page.evaluate = jest.fn().mockRejectedValue(new Error('context destroyed'));

        const replay = new ActionReplay(settings(0), async () => 'hash-account', () => undefined);
        await expect(replay.performAction({} as any, action, page as any)).resolves.toBeUndefined();
    });
});
