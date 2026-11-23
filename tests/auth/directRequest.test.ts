/**
 * requestDirect — the credential-less request sent straight to the target
 * (SCAN-236). Runs against a real local HTTP server.
 */

import * as http from 'http';
import { AddressInfo } from 'net';

import { requestDirect, toProbeResult } from '../../src/auth/directRequest';

describe('requestDirect', () => {
    let server: http.Server;
    let base: string;
    const seen: http.IncomingHttpHeaders[] = [];

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            seen.push(req.headers);
            if (req.url === '/api/me') {
                if (req.headers.cookie || req.headers.authorization) {
                    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ id: 1, email: 'a@b' }));
                } else {
                    res.writeHead(401, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: 'unauthorized' }));
                }
            } else if (req.url === '/dashboard') {
                res.writeHead(302, { location: '/login?next=%2Fdashboard' });
                res.end();
            } else if (req.url === '/big') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(`{"k":"${'x'.repeat(2 * 1024 * 1024)}"}`);
            } else {
                res.writeHead(200, { 'content-type': 'text/html' });
                res.end('<html></html>');
            }
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('sends only the headers it is given', async () => {
        seen.length = 0;
        const result = await requestDirect(`${base}/api/me`, { accept: 'application/json' }, { timeoutMs: 5000 });
        expect(result).toEqual({
            status: 401,
            contentType: 'application/json',
            finalUrl: `${base}/api/me`,
            body: '{"error":"unauthorized"}',
        });
        expect(seen[0]!.cookie).toBeUndefined();
        expect(seen[0]!.authorization).toBeUndefined();
        expect(seen[0]!.accept).toBe('application/json');
    });

    it('reports a redirect as its target, without following it', async () => {
        seen.length = 0;
        const result = await requestDirect(`${base}/dashboard`, {}, { timeoutMs: 5000 });
        expect(result.status).toBe(302);
        expect(result.finalUrl).toBe(`${base}/login?next=%2Fdashboard`);
        expect(seen).toHaveLength(1);
    });

    it('answers status 0 when the target is unreachable', async () => {
        const result = await requestDirect('http://127.0.0.1:1/x', {}, { timeoutMs: 2000 });
        expect(result.status).toBe(0);
    });

    it('answers status 0 for a URL it cannot parse', async () => {
        expect((await requestDirect('not a url', {}, { timeoutMs: 1000 })).status).toBe(0);
    });

    it('stops reading a huge body and still reports the status', async () => {
        const result = await requestDirect(`${base}/big`, {}, { timeoutMs: 5000 });
        expect(result.status).toBe(200);
        expect(result.body.length).toBeLessThanOrEqual(256 * 1024);
    });
});

describe('toProbeResult', () => {
    it('keeps only the media type, lower case', () => {
        expect(toProbeResult(200, 'Application/JSON; charset=UTF-8', 'u', '{}').contentType).toBe('application/json');
    });

    it('keeps the body, cut at 256 KB', () => {
        expect(toProbeResult(200, 'application/json', 'u', '{"a":1}').body).toBe('{"a":1}');
        expect(toProbeResult(200, 'text/html', 'u', 'x'.repeat(300 * 1024)).body).toHaveLength(256 * 1024);
    });

    it('handles a missing content type', () => {
        expect(toProbeResult(204, undefined, 'u', '')).toEqual({ status: 204, contentType: '', finalUrl: 'u', body: '' });
    });
});
