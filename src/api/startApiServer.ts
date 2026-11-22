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

let processGuardsInstalled = false;

/**
 * Keeps the API service alive when a scan leaks an error the scan boundary did
 * not catch. Sasori-in-API-mode is a long-lived service many clients drive, so a
 * single crawl's stray rejection (Puppeteer is a frequent source — a navigation
 * timeout thrown from a detached watcher, a browser that closed mid-step) must
 * never take the whole process down and every other client's scans with it. Each
 * scan owns its own browser and the HTTP server is independent, so logging and
 * staying up is strictly safer than exiting. Installed once.
 */
function installServiceProcessGuards(): void {
    if (processGuardsInstalled) return;
    processGuardsInstalled = true;
    process.on('unhandledRejection', (reason) => {
        console.error(
            '[sasori api] unhandledRejection (service stays up):',
            reason instanceof Error ? reason.stack : reason,
        );
    });
    process.on('uncaughtException', (err) => {
        console.error(
            '[sasori api] uncaughtException (service stays up):',
            err instanceof Error ? err.stack : err,
        );
    });
}

/**
 * Binds the HTTP API (default `0.0.0.0:8080`).
 */
export function startApiServer(options: StartApiServerOptions = {}): Promise<StartedApiServer> {
    installServiceProcessGuards();
    const host = options.host ?? '0.0.0.0';
    const port = options.port ?? 8080;
    const registry = options.registry ?? new ScanRegistry();
    // Drains any completion callbacks left undelivered by a previous process,
    // then keeps retrying in the background.
    registry.startBackgroundDelivery();
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
