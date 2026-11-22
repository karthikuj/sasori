import EndpointInventory from '../../src/crawler/endpointInventory';

describe('EndpointInventory', () => {
    it('aggregates repeated requests into one endpoint', () => {
        const inv = new EndpointInventory('https://example.com/');
        inv.recordRequest('GET', 'https://example.com/search?q=a');
        inv.recordRequest('GET', 'https://example.com/search?q=b');
        inv.recordRequest('get', 'https://example.com/search?q=c&page=2');

        const snap = inv.snapshot();
        expect(snap.endpoints).toHaveLength(1);
        const [endpoint] = snap.endpoints;
        expect(endpoint!.url).toBe('https://example.com/search');
        expect(endpoint!.method).toBe('GET');
        expect(endpoint!.requests).toBe(3);
        // Values differ per request; the parameter *names* are the surface.
        expect(endpoint!.queryParams).toEqual(['page', 'q']);
        expect(snap.stats).toEqual({ endpoints: 1, states: 0, requests: 3 });
    });

    it('separates methods at the same URL', () => {
        const inv = new EndpointInventory();
        inv.recordRequest('GET', 'https://example.com/login');
        inv.recordRequest('POST', 'https://example.com/login');

        expect(inv.snapshot().endpoints.map((e) => e.method)).toEqual(['GET', 'POST']);
    });

    it('drops the fragment and keeps the path', () => {
        const inv = new EndpointInventory();
        inv.recordRequest('GET', 'https://example.com/docs/page#section-2');

        expect(inv.snapshot().endpoints[0]!.url).toBe('https://example.com/docs/page');
    });

    it('records form body parameters', () => {
        const inv = new EndpointInventory();
        inv.recordRequest('POST', 'https://example.com/login', {
            postData: 'username=admin&password=x',
            contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
        });

        const [endpoint] = inv.snapshot().endpoints;
        expect(endpoint!.bodyParams).toEqual(['password', 'username']);
        expect(endpoint!.contentTypes).toEqual(['application/x-www-form-urlencoded']);
    });

    it('records JSON body keys', () => {
        const inv = new EndpointInventory();
        inv.recordRequest('POST', 'https://example.com/api/products', {
            postData: '{"search":"x","limit":10}',
            contentType: 'application/json',
        });

        expect(inv.snapshot().endpoints[0]!.bodyParams).toEqual(['limit', 'search']);
    });

    it('does not invent parameters for a body it cannot parse', () => {
        const inv = new EndpointInventory();
        inv.recordRequest('POST', 'https://example.com/upload', {
            postData: '--boundary\r\nContent-Disposition: form-data; name="file"\r\n',
            contentType: 'multipart/form-data; boundary=boundary',
        });
        inv.recordRequest('POST', 'https://example.com/api/broken', {
            postData: 'not json at all',
            contentType: 'application/json',
        });

        for (const endpoint of inv.snapshot().endpoints) {
            expect(endpoint.bodyParams).toEqual([]);
        }
    });

    it('ignores a URL the platform cannot parse instead of throwing', () => {
        const inv = new EndpointInventory();
        // Thrown from inside Puppeteer's interception handler this would hang
        // the page, so it has to be swallowed.
        expect(() => inv.recordRequest('GET', 'not-a-url')).not.toThrow();
        expect(inv.snapshot().endpoints).toHaveLength(0);
    });

    it('keeps DOM states distinct at one URL and de-duplicates by hash', () => {
        const inv = new EndpointInventory();
        const state = { url: 'https://example.com/app', crawlDepth: 1, arrivalType: 'dom', actions: 2, inputs: ['input[type="text"]'] };
        inv.recordState({ ...state, stateHash: 'aaa' });
        inv.recordState({ ...state, stateHash: 'bbb' });
        inv.recordState({ ...state, stateHash: 'aaa' });

        const snap = inv.snapshot();
        expect(snap.states.map((s) => s.stateHash)).toEqual(['aaa', 'bbb']);
        expect(snap.stats.states).toBe(2);
    });

    it('produces byte-identical output regardless of arrival order', () => {
        const build = (reversed: boolean): string => {
            const inv = new EndpointInventory('https://example.com/');
            const calls: Array<() => void> = [
                () => inv.recordRequest('GET', 'https://example.com/b?z=1&a=2'),
                () => inv.recordRequest('POST', 'https://example.com/a', { postData: 'y=1&x=2', contentType: 'application/x-www-form-urlencoded' }),
                () => inv.recordRequest('GET', 'https://example.com/a'),
                () => inv.recordState({ url: 'https://example.com/b', stateHash: 'zzz', crawlDepth: 1, arrivalType: 'link', inputs: ['textarea', 'select'] }),
                () => inv.recordState({ url: 'https://example.com/a', stateHash: 'aaa', crawlDepth: 0, arrivalType: 'link' }),
            ];
            for (const call of reversed ? [...calls].reverse() : calls) {
                call();
            }
            return JSON.stringify(inv.snapshot());
        };

        // Browsers crawl concurrently, so the order requests are recorded in is
        // a race. The artifact is diffed between runs; it must not be.
        expect(build(false)).toBe(build(true));
    });

    it('snapshots do not alias internal state', () => {
        const inv = new EndpointInventory();
        inv.recordRequest('GET', 'https://example.com/a?one=1');
        const first = inv.snapshot();
        inv.recordRequest('GET', 'https://example.com/a?two=2');

        expect(first.endpoints[0]!.queryParams).toEqual(['one']);
        expect(inv.snapshot().endpoints[0]!.queryParams).toEqual(['one', 'two']);
    });
});
