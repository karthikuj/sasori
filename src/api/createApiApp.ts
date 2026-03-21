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
            const record = registry.createScan(req.body);
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
