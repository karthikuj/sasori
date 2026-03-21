import type { AddressInfo } from 'net';
import type { Server } from 'http';

import { createApiApp } from './createApiApp';
import { ScanRegistry } from './scanRegistry';

export interface StartApiServerOptions {
    host?: string;
    port?: number;
    registry?: ScanRegistry;
}

export interface StartedApiServer {
    server: Server;
    registry: ScanRegistry;
    port: number;
    host: string;
}

/**
 * Binds the HTTP API (default `0.0.0.0:8080`).
 */
export function startApiServer(options: StartApiServerOptions = {}): Promise<StartedApiServer> {
    const host = options.host ?? '0.0.0.0';
    const port = options.port ?? 8080;
    const registry = options.registry ?? new ScanRegistry();
    const app = createApiApp(registry);

    return new Promise((resolve, reject) => {
        const server = app.listen(port, host, () => {
            const addr = server.address();
            const listenPort =
                typeof addr === 'object' && addr !== null && 'port' in addr
                    ? (addr as AddressInfo).port
                    : port;
            resolve({ server, registry, port: listenPort, host });
        });
        server.once('error', reject);
    });
}
