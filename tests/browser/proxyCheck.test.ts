/**
 * checkProxyReachable: fail fast, with a clear message, when the configured
 * proxy is not running.
 */

import net from 'net';

import { checkProxyReachable } from '../../src/browser/proxyCheck';

/** Starts a TCP server on a free port. */
async function listen(onConnection?: (socket: net.Socket) => void): Promise<{ server: net.Server; port: number }> {
    const server = net.createServer(onConnection ?? ((socket) => socket.end()));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as net.AddressInfo).port };
}

/** A port that was free a moment ago, so nothing is listening on it. */
async function closedPort(): Promise<number> {
    const { server, port } = await listen();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

describe('checkProxyReachable', () => {
    it('resolves when something accepts connections', async () => {
        const { server, port } = await listen();
        try {
            await expect(checkProxyReachable('127.0.0.1', port)).resolves.toBeUndefined();
        } finally {
            server.close();
        }
    });

    it('rejects with the proxy address and the fix when nothing listens', async () => {
        const port = await closedPort();
        const check = checkProxyReachable('127.0.0.1', port);
        await expect(check).rejects.toThrow(`Proxy 127.0.0.1:${port} is not reachable (ECONNREFUSED)`);
        await expect(checkProxyReachable('127.0.0.1', port)).rejects.toThrow('set browser.proxy.enabled to false');
    });

    it('rejects when the connection is not accepted in time', async () => {
        // 192.0.2.0/24 is reserved for documentation (RFC 5737): nothing
        // answers there, so the connection either hangs until the timeout or
        // fails at once on hosts with no route. Both must reject.
        await expect(checkProxyReachable('192.0.2.1', 9, 50)).rejects.toThrow('Proxy 192.0.2.1:9 is not reachable');
    });
});
