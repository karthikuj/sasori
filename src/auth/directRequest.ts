import * as http from 'http';
import * as https from 'https';
import { readFileSync } from 'fs';
import { rootCertificates } from 'tls';

import { MAX_PROBE_BODY_CHARS, ProbeResult } from './sessionCheck';

/** Largest body read to find JSON keys. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface DirectRequestOptions {
    timeoutMs: number;
    /** Extra PEM CA files to trust on top of Node's own roots. */
    caPaths?: string[];
    /** Accept any certificate (`browser.tls.allowInsecureFallback`). */
    allowInsecure?: boolean;
}

/** Builds a {@link ProbeResult} from a response's parts. */
export function toProbeResult(status: number, contentTypeHeader: string | undefined, finalUrl: string, body: string): ProbeResult {
    const contentType = (contentTypeHeader ?? '').split(';')[0]!.trim().toLowerCase();
    return { status, contentType, finalUrl, body: body.slice(0, MAX_PROBE_BODY_CHARS) };
}

/**
 * Sends a `GET` from Node, straight to the target: not through the browser,
 * so it carries none of the session, and not through the proxy, so it never
 * lands in the inventory as a request the crawled identity made (SCAN-236).
 *
 * Redirects are not followed: a redirect is the answer, and `finalUrl` is where
 * it points.
 * @param url - URL to request.
 * @param headers - Headers to send; the caller has removed credentials.
 * @param options - Timeout and TLS trust.
 * @return The answer, with status 0 when the request failed.
 */
export async function requestDirect(
    url: string,
    headers: Record<string, string>,
    options: DirectRequestOptions,
): Promise<ProbeResult> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { status: 0, contentType: '', finalUrl: url, body: '' };
    }
    const isHttps = parsed.protocol === 'https:';
    const ca = isHttps ? loadCa(options.caPaths) : undefined;

    return new Promise<ProbeResult>((resolve) => {
        const transport = isHttps ? https : http;
        const req = transport.request(
            parsed,
            {
                method: 'GET',
                headers,
                timeout: options.timeoutMs,
                ...(isHttps ? { rejectUnauthorized: !options.allowInsecure, ...(ca ? { ca } : {}) } : {}),
            },
            (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    if (size <= MAX_BODY_BYTES) {
                        chunks.push(chunk);
                    } else {
                        res.destroy();
                    }
                });
                const finish = (): void => {
                    const status = res.statusCode ?? 0;
                    const location = res.headers.location;
                    let finalUrl = url;
                    if (status >= 300 && status < 400 && location) {
                        try {
                            finalUrl = new URL(location, url).href;
                        } catch {
                            finalUrl = location;
                        }
                    }
                    resolve(toProbeResult(status, res.headers['content-type'], finalUrl, Buffer.concat(chunks).toString('utf8')));
                };
                res.on('end', finish);
                res.on('close', finish);
                res.on('error', finish);
            },
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', () => resolve({ status: 0, contentType: '', finalUrl: url, body: '' }));
        req.end();
    });
}

function loadCa(caPaths: string[] | undefined): string[] | undefined {
    const files = (caPaths ?? []).filter((p) => p && p.trim().length > 0);
    if (files.length === 0) {
        return undefined;
    }
    const extra: string[] = [];
    for (const file of files) {
        try {
            extra.push(readFileSync(file, 'utf8'));
        } catch {
            // An unreadable CA only matters if the target needs it; the request
            // then fails and the candidate is skipped.
        }
    }
    return [...rootCertificates, ...extra];
}
