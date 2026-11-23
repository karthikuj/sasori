/**
 * Session check rules (SCAN-236): which request may serve as the check, and
 * how its answer tells a logout apart.
 */

import {
    ObservedRequest,
    ProbeResult,
    SessionCheckRequest,
    classifyCandidate,
    deriveMarkers,
    isCheckCandidate,
    judgeProbe,
    pickCheck,
    rankCandidates,
    refreshCheckToken,
    replayableHeaders,
    sessionStorageLoginKeys,
    statusDiffers,
    stripCredentials,
} from '../../src/auth/sessionCheck';

const inScope = (url: string) => url.startsWith('https://app.test/');

function req(overrides: Partial<ObservedRequest> = {}): ObservedRequest {
    return {
        url: 'https://app.test/api/feed',
        method: 'GET',
        resourceType: 'fetch',
        status: 200,
        headers: {},
        ...overrides,
    };
}

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
    return {
        status: 200,
        contentType: 'application/json',
        finalUrl: 'https://app.test/api/me',
        body: '{"id":7,"email":"buyer1@kirimaru.test","name":"Buyer One","role":"buyer"}',
        ...overrides,
    };
}

describe('isCheckCandidate', () => {
    it('accepts an in-scope fetch or XHR GET answered with 2xx', () => {
        expect(isCheckCandidate(req(), inScope)).toBe(true);
        expect(isCheckCandidate(req({ resourceType: 'xhr', status: 204 }), inScope)).toBe(true);
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('never accepts %s, even one that looks harmless', (method) => {
        expect(isCheckCandidate(req({ method, url: 'https://app.test/api/me' }), inScope)).toBe(false);
    });

    it.each(['document', 'script', 'image', 'stylesheet'])('only accepts fetch/XHR, not %s', (resourceType) => {
        expect(isCheckCandidate(req({ resourceType }), inScope)).toBe(false);
    });

    it('rejects non-2xx answers and out-of-scope requests', () => {
        expect(isCheckCandidate(req({ status: 302 }), inScope)).toBe(false);
        expect(isCheckCandidate(req({ status: 401 }), inScope)).toBe(false);
        expect(isCheckCandidate(req({ url: 'https://cdn.other/x' }), inScope)).toBe(false);
    });

    it('treats the method case-insensitively', () => {
        expect(isCheckCandidate(req({ method: 'get' }), inScope)).toBe(true);
    });
});

describe('rankCandidates', () => {
    it('puts session endpoints and token-bearing requests first, otherwise keeps app order', () => {
        const ranked = rankCandidates([
            req({ url: 'https://app.test/api/feed' }),
            req({ url: 'https://app.test/api/notifications', headers: { authorization: 'Bearer t' } }),
            req({ url: 'https://app.test/api/me' }),
            req({ url: 'https://app.test/api/items' }),
        ], inScope);
        expect(ranked.map((r) => r.url)).toEqual([
            'https://app.test/api/me',
            'https://app.test/api/notifications',
            'https://app.test/api/feed',
            'https://app.test/api/items',
        ]);
    });

    it('keeps one request per URL, drops non-candidates, and caps the list', () => {
        const ranked = rankCandidates([
            req({ url: 'https://app.test/a' }),
            req({ url: 'https://app.test/a' }),
            req({ url: 'https://app.test/login', method: 'POST' }),
            req({ url: 'https://app.test/b' }),
            req({ url: 'https://app.test/c' }),
        ], inScope, 2);
        expect(ranked.map((r) => r.url)).toEqual(['https://app.test/a', 'https://app.test/b']);
    });

    it.each([
        '/api/me', '/user', '/api/session', '/profile', '/account/', '/auth/status', '/api/whoami', '/current-user',
    ])('recognises %s as a session endpoint', (path) => {
        const ranked = rankCandidates([req({ url: 'https://app.test/zzz' }), req({ url: `https://app.test${path}` })], inScope);
        expect(ranked[0]!.url).toBe(`https://app.test${path}`);
    });
});

describe('headers', () => {
    const sent = {
        authorization: 'Bearer abc',
        cookie: 'sid=1',
        accept: 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'x-csrf-token': 'c',
        'user-agent': 'Chrome',
        referer: 'https://app.test/',
    };

    it('repeats the token, Accept and X- headers, and leaves the rest to the browser', () => {
        expect(replayableHeaders(sent)).toEqual({
            authorization: 'Bearer abc',
            accept: 'application/json',
            'x-requested-with': 'XMLHttpRequest',
            'x-csrf-token': 'c',
        });
    });

    it('removes every credential for the credential-less request', () => {
        expect(stripCredentials(sent)).toEqual({
            accept: 'application/json',
            'x-requested-with': 'XMLHttpRequest',
            'user-agent': 'Chrome',
            referer: 'https://app.test/',
        });
    });
});

const OUT_JSON = probe({ body: '{"error":"unauthorized","message":"Sign in first"}' });

describe('statusDiffers', () => {
    it.each([
        ['401', probe({ status: 401 })],
        ['403', probe({ status: 403 })],
        ['a redirect (another status class)', probe({ status: 302 })],
        ['an answer that ended up at the login page', probe({ finalUrl: 'https://app.test/login?next=%2Fapi%2Fme' })],
    ])('is true for %s', (_label, other) => {
        expect(statusDiffers(probe(), other)).toBe(true);
    });

    it('is false for the same status at the same place, whatever the body', () => {
        expect(statusDiffers(probe(), OUT_JSON)).toBe(false);
    });

    it('ignores the query string', () => {
        expect(statusDiffers(probe(), probe({ finalUrl: 'https://app.test/api/me?ts=2' }))).toBe(false);
    });
});

describe('deriveMarkers', () => {
    it('keeps what both logged-in answers have and the logged-out one lacks, the email first', () => {
        const markers = deriveMarkers(probe(), probe(), OUT_JSON);
        expect(markers[0]).toBe('buyer1@kirimaru.test');
        expect(markers).toContain('Buyer');
        expect(markers).toContain('buyer');
        expect(markers).not.toContain('error');
    });

    it('never keeps what changes from one request to the next', () => {
        const a = probe({ body: '<p>Hi buyer1@kirimaru.test, nonce a1b2c3d4e5, at 12:00:01</p>' });
        const b = probe({ body: '<p>Hi buyer1@kirimaru.test, nonce f6g7h8i9j0, at 12:00:02</p>' });
        const out = probe({ body: '<p>Please sign in</p>' });
        const markers = deriveMarkers(a, b, out);
        expect(markers[0]).toBe('buyer1@kirimaru.test');
        for (const changing of ['a1b2c3d4e5', 'f6g7h8i9j0', '12:00:01', '12:00:02']) {
            expect(markers).not.toContain(changing);
        }
    });

    it('never keeps markup both answers share', () => {
        const a = probe({ body: '<div class="container-fluid navbar">Welcome! Heisenberg</div>' });
        const out = probe({ body: '<div class="container-fluid navbar">Please login first.</div>' });
        expect(deriveMarkers(a, a, out).sort()).toEqual(['Heisenberg', 'Welcome'].sort());
    });

    it('caps the number of markers', () => {
        const words = Array.from({ length: 20 }, (_, i) => `word${i}x`).join(' ');
        expect(deriveMarkers(probe({ body: words }), probe({ body: words }), probe({ body: '' }))).toHaveLength(5);
    });

    it('finds nothing when the answers are the same', () => {
        expect(deriveMarkers(probe(), probe(), probe())).toEqual([]);
    });
});

describe('classifyCandidate', () => {
    const evidence = (loggedOut: ProbeResult, loggedIn: ProbeResult = probe(), loggedInAgain: ProbeResult = loggedIn) =>
        ({ url: 'https://app.test/api/me', headers: {}, loggedIn, loggedInAgain, loggedOut });

    it('is a status check when the status changes without the login', () => {
        expect(classifyCandidate(evidence(probe({ status: 401 })))).toMatchObject({ kind: 'status' });
        expect(classifyCandidate(evidence(probe({ status: 302, finalUrl: 'https://app.test/login' })))).toMatchObject({ kind: 'status' });
    });

    it('is a body check, with markers, when only the body changes', () => {
        const check = classifyCandidate(evidence(OUT_JSON));
        expect(check).toMatchObject({ kind: 'body' });
        expect(check!.markers![0]).toBe('buyer1@kirimaru.test');
    });

    it('is nothing for a public request that answers the same', () => {
        expect(classifyCandidate(evidence(probe()))).toBeNull();
    });

    it('is nothing when the logged-in answer was not 2xx, or the logged-out request failed', () => {
        expect(classifyCandidate(evidence(probe({ status: 401 }), probe({ status: 302 })))).toBeNull();
        expect(classifyCandidate(evidence(probe({ status: 0, body: '' })))).toBeNull();
    });

    it('is nothing when the body changes only in what changes per request anyway', () => {
        const a = probe({ body: '{"time":"12:00:01"}' });
        const b = probe({ body: '{"time":"12:00:02"}' });
        expect(classifyCandidate(evidence(probe({ body: '{"time":"12:00:03"}' }), a, b))).toBeNull();
    });
});

describe('pickCheck', () => {
    const status = { url: 's', headers: {}, baseline: probe(), kind: 'status' as const };
    const body = { url: 'b', headers: {}, baseline: probe(), kind: 'body' as const, markers: ['x'] };

    it('prefers a status check, even ranked lower', () => {
        expect(pickCheck([null, body, status])).toBe(status);
    });

    it('takes the best-ranked body check when no status check exists', () => {
        const body2 = { ...body, url: 'b2' };
        expect(pickCheck([body, null, body2])).toBe(body);
    });

    it('is null when nothing qualified', () => {
        expect(pickCheck([null, null])).toBeNull();
        expect(pickCheck([])).toBeNull();
    });
});

describe('judgeProbe', () => {
    const statusCheck = { url: 'u', headers: {}, baseline: probe(), kind: 'status' as const };
    const bodyCheck = { url: 'u', headers: {}, baseline: probe(), kind: 'body' as const, markers: ['buyer1@kirimaru.test', 'Buyer'] };
    const regexCheck = { url: 'u', headers: {}, baseline: probe(), kind: 'regex' as const, loggedInRegex: 'Welcome! \\w+' };

    it.each([
        ['a failed request', probe({ status: 0, body: '' })],
        ['a 500', probe({ status: 500 })],
        ['a 503', probe({ status: 503 })],
    ])('is inconclusive on %s, for every kind', (_label, observed) => {
        for (const check of [statusCheck, bodyCheck, regexCheck]) {
            expect(judgeProbe(check, observed)).toBe('inconclusive');
        }
    });

    describe('status checks', () => {
        it('are ok while the status and the place stay', () => {
            expect(judgeProbe(statusCheck, OUT_JSON)).toBe('ok'); // the body is not what they judge
        });

        it.each([
            ['401', probe({ status: 401 })],
            ['a redirect to the login page', probe({ finalUrl: 'https://app.test/login' })],
        ])('are logged out on %s', (_label, observed) => {
            expect(judgeProbe(statusCheck, observed)).toBe('loggedOut');
        });
    });

    describe('body checks', () => {
        it('are ok while any marker is present', () => {
            expect(judgeProbe(bodyCheck, probe({ body: '{"name":"Buyer One","email":"changed@x.test"}' }))).toBe('ok');
        });

        it('are logged out when every marker is gone', () => {
            expect(judgeProbe(bodyCheck, OUT_JSON)).toBe('loggedOut');
        });

        it('are logged out on a status change too', () => {
            expect(judgeProbe(bodyCheck, probe({ status: 401 }))).toBe('loggedOut');
        });

        it('match whole words, not fragments', () => {
            expect(judgeProbe(bodyCheck, probe({ body: '{"note":"Buyers welcome"}' }))).toBe('loggedOut');
        });
    });

    describe('regex checks', () => {
        it('are ok while the pattern matches', () => {
            expect(judgeProbe(regexCheck, probe({ body: '<h1>Welcome! Heisenberg</h1>' }))).toBe('ok');
        });

        it('are logged out when it stops matching, even with a 200 at the same URL', () => {
            expect(judgeProbe(regexCheck, probe({ body: '<h1>Please login first.</h1>' }))).toBe('loggedOut');
        });

        it('are logged out on a 401 or 403', () => {
            expect(judgeProbe(regexCheck, probe({ status: 403, body: 'Welcome! x' }))).toBe('loggedOut');
        });

        it('are case-sensitive, as documented', () => {
            expect(judgeProbe(regexCheck, probe({ body: 'welcome! heisenberg' }))).toBe('loggedOut');
        });
    });
});

describe('refreshCheckToken', () => {
    function check(token: string | undefined): SessionCheckRequest {
        return {
            url: 'https://app.test/api/me',
            headers: token === undefined ? {} : { authorization: token },
            baseline: probe(),
            kind: 'status',
        };
    }

    it('takes a token the app refreshed on its own, from the same origin', () => {
        const c = check('Bearer old');
        expect(refreshCheckToken(c, 'https://app.test/api/feed', { authorization: 'Bearer new' })).toBe(true);
        expect(c.headers['authorization']).toBe('Bearer new');
    });

    it('ignores another origin, an unchanged token, and requests without one', () => {
        const c = check('Bearer old');
        expect(refreshCheckToken(c, 'https://other.test/x', { authorization: 'Bearer evil' })).toBe(false);
        expect(refreshCheckToken(c, 'https://app.test/x', { authorization: 'Bearer old' })).toBe(false);
        expect(refreshCheckToken(c, 'https://app.test/x', {})).toBe(false);
        expect(c.headers['authorization']).toBe('Bearer old');
    });

    it('does not add a token to a check that never sent one (a cookie session)', () => {
        const c = check(undefined);
        expect(refreshCheckToken(c, 'https://app.test/x', { authorization: 'Basic abc' })).toBe(false);
        expect(c.headers).toEqual({});
    });
});

describe('sessionStorageLoginKeys', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

    it('finds keys named like a token, and JWT-shaped values', () => {
        expect(sessionStorageLoginKeys([
            ['accessToken', 'x'],
            ['msal.account.keys', '[]'],
            ['opaque', jwt],
            ['state', JSON.stringify({ access_token: 'abc' })],
        ])).toEqual(['accessToken', 'msal.account.keys', 'opaque', 'state']);
    });

    it('ignores ordinary UI state', () => {
        expect(sessionStorageLoginKeys([
            ['scrollPosition', '120'],
            ['lastTab', 'orders'],
            ['theme', 'dark'],
        ])).toEqual([]);
    });
});
