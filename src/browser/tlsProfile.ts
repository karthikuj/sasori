import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

/**
 * Creates a temporary Chromium user-data directory whose NSS database trusts the given PEM CA files.
 * Used so HTTPS through a MITM proxy (e.g. Nara) validates without `--ignore-certificate-errors`.
 *
 * Requires `certutil` on PATH (Debian/Ubuntu: `libnss3-tools`, Fedora/RHEL: `nss-tools`).
 */
export function prepareTlsUserDataDir(caPemPaths: string[]): string {
    const userDataDir = mkdtempSync(join(tmpdir(), 'sasori-tls-'));
    const nssDir = join(userDataDir, 'Default');
    mkdirSync(nssDir, { recursive: true });
    const db = `sql:${nssDir}`;

    let r = spawnSync('certutil', ['-d', db, '-N', '--empty-password'], { encoding: 'utf-8' });
    const spawnErr = r.error as NodeJS.ErrnoException | undefined;
    if (spawnErr?.code === 'ENOENT') {
        throw new Error(
            'certutil not found (install nss-tools / libnss3-tools) to use browser.tls.extraCaCerts',
        );
    }
    if (r.status !== 0) {
        throw new Error(`certutil -N failed: ${r.stderr || r.stdout || r.error}`);
    }

    for (let i = 0; i < caPemPaths.length; i++) {
        const p = caPemPaths[i]!;
        const abs = p.startsWith('/') ? p : join(process.cwd(), p);
        if (!existsSync(abs)) {
            throw new Error(`CA file not found: ${abs}`);
        }
        const nickname = `sasori-ca-${i}`;
        r = spawnSync(
            'certutil',
            ['-d', db, '-A', '-t', 'C,,', '-n', nickname, '-i', abs],
            { encoding: 'utf-8' },
        );
        if (r.status !== 0) {
            throw new Error(`certutil -A failed for ${abs}: ${r.stderr || r.stdout}`);
        }
    }

    return userDataDir;
}

/**
 * Deletes a profile directory made by {@link prepareTlsUserDataDir}.
 *
 * Every crawl used to leave one `/tmp/sasori-tls-*` directory per browser
 * behind, because nothing removed them (SCAN-236). Never throws: a profile that
 * cannot be deleted must not turn a finished crawl into a failed one.
 * @param userDataDir - Directory to delete; ignored when empty.
 */
export function removeUserDataDir(userDataDir: string | null | undefined): void {
    if (!userDataDir) {
        return;
    }
    try {
        rmSync(userDataDir, { recursive: true, force: true });
    } catch (e) {
        console.warn(`[sasori] Could not delete browser profile ${userDataDir}: ${e instanceof Error ? e.message : String(e)}`);
    }
}
