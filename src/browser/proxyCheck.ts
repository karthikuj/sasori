import net from 'net';

/** How long the proxy may take to accept a connection before it counts as down. */
export const PROXY_CHECK_TIMEOUT_MS = 5000;

/**
 * Checks that something accepts TCP connections at the configured proxy, before
 * Chrome is launched with it.
 *
 * Without this check, a proxy that is not running shows up as
 * `net::ERR_PROXY_CONNECTION_FAILED` on the first page load (usually the login
 * page), which reads as a login or browser problem rather than a missing proxy.
 *
 * @param host The proxy host.
 * @param port The proxy port.
 * @param timeoutMs How long to wait for the connection.
 * @return Resolves when the connection is accepted; rejects with a message that
 *     names the proxy and how to fix it otherwise.
 */
export function checkProxyReachable(host: string, port: number, timeoutMs = PROXY_CHECK_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        let settled = false;
        const finish = (error?: string): void => {
            if (settled) {
                return;
            }
            settled = true;
            socket.destroy();
            if (error === undefined) {
                resolve();
                return;
            }
            reject(new Error(
                `Proxy ${host}:${port} is not reachable (${error}). ` +
                'Start the proxy, or set browser.proxy.enabled to false in the config.',
            ));
        };
        socket.setTimeout(timeoutMs, () => finish(`no answer within ${timeoutMs} ms`));
        socket.once('connect', () => finish());
        socket.once('error', (err: NodeJS.ErrnoException) => finish(err.code ?? err.message));
    });
}

export default checkProxyReachable;
