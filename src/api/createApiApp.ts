import express, { Request, Response, NextFunction } from 'express';

import type { ScanRegistry } from './scanRegistry';

/**
 * JSON REST API for starting and managing concurrent Sasori scans.
 */
export function createApiApp(registry: ScanRegistry): express.Application {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '2mb' }));

    const v1 = express.Router();

    v1.get('/scans', (_req: Request, res: Response) => {
        res.json({ scans: registry.listScans() });
    });

    v1.post('/scans', (req: Request, res: Response, next: NextFunction) => {
        try {
            const body = (req.body ?? {}) as Record<string, unknown>;
            const callbackRaw = body.nara_callback as Record<string, unknown> | undefined;
            const callback =
                callbackRaw && typeof callbackRaw.url === 'string'
                    ? {
                        url: callbackRaw.url,
                        ...(typeof callbackRaw.secret === 'string' ? {secret: callbackRaw.secret} : {}),
                    }
                    : undefined;
            const backendScanId =
                typeof callbackRaw?.backend_scan_id === 'number'
                    ? callbackRaw.backend_scan_id
                    : undefined;
            const meta = {
                ...(callback ? {callback} : {}),
                ...(typeof backendScanId === 'number' ? {backendScanId} : {}),
            };
            const record = registry.createScan(req.body, meta);
            res.status(201).json(record);
        } catch (err) {
            next(err);
        }
    });

    v1.get('/scans/:scanId', (req: Request, res: Response) => {
        const id = typeof req.params.scanId === 'string' ? req.params.scanId : req.params.scanId?.[0] ?? '';
        const record = registry.getScan(id);
        if (!record) {
            res.status(404).json({ error: 'Scan not found' });
            return;
        }
        res.json(record);
    });

    v1.get('/scans/:scanId/inventory', (req: Request, res: Response) => {
        const id = typeof req.params.scanId === 'string' ? req.params.scanId : req.params.scanId?.[0] ?? '';
        const inventory = registry.getInventory(id);
        if (!inventory) {
            // 404 covers both an unknown scan and one that failed before a
            // crawler existed. They are the same answer to the only question the
            // caller can act on: there is no coverage to read here.
            res.status(404).json({ error: 'No inventory for this scan' });
            return;
        }
        res.json(inventory);
    });

    v1.get('/scans/:scanId/crawl-graph', (req: Request, res: Response) => {
        const id = typeof req.params.scanId === 'string' ? req.params.scanId : req.params.scanId?.[0] ?? '';
        const graph = registry.getCrawlGraph(id);
        if (graph === undefined) {
            res.status(404).json({ error: 'Scan not found' });
            return;
        }
        if (graph === null) {
            // The scan exists but recorded no graph — `recordCrawlGraph` was off,
            // or it failed before a crawl began. Distinguished from 404 because
            // the caller can act on it: turn recording on for the next scan.
            res.status(404).json({ error: 'No crawl graph for this scan' });
            return;
        }
        res.json(graph);
    });

    v1.delete('/scans/:scanId', (req: Request, res: Response) => {
        const id = typeof req.params.scanId === 'string' ? req.params.scanId : req.params.scanId?.[0] ?? '';
        const result = registry.stopScan(id);
        if (!result.ok) {
            if (result.reason === 'not_found') {
                res.status(404).json({ error: 'Scan not found' });
                return;
            }
            res.status(409).json({ error: 'Scan is not running' });
            return;
        }
        res.status(200).json({ ok: true, scanId: id });
    });

    app.use('/api/v1', v1);

    app.get('/health', (_req: Request, res: Response) => {
        res.json({ status: 'ok' });
    });

    app.use((_req: Request, res: Response) => {
        res.status(404).json({ error: 'Not found' });
    });

    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        const message = err instanceof Error ? err.message : 'Invalid request';
        res.status(400).json({ error: message });
    });

    return app;
}
