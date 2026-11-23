/**
 * BrowserSession — one Chrome whose windows are the crawl workers (SCAN-236).
 */

import { mkdtempSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Browser as PuppeteerBrowser } from 'puppeteer';

import BrowserSession from '../../src/browser/browserSession';
import { removeUserDataDir } from '../../src/browser/tlsProfile';
import { BrowserConfig } from '../../src/types/browser';
import { FakeBrowser, FakePage, flush } from './fakeBrowser';

/** Temporary directories made here, removed after each test even if it fails. */
const tempDirs: string[] = [];
afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sasori-tls-test-'));
    tempDirs.push(dir);
    return dir;
}

const config: BrowserConfig = { headless: true, maximize: false, proxy: { enabled: false }, instances: 4 };

function session(profile: string | null = null, onCrash = jest.fn()) {
    const browsers: FakeBrowser[] = [];
    const launcher = jest.fn(async () => {
        const browser = new FakeBrowser();
        browsers.push(browser);
        return { browser: browser as unknown as PuppeteerBrowser, userDataDir: profile };
    });
    return { s: new BrowserSession(config, onCrash, launcher), browsers, launcher, onCrash };
}

describe('BrowserSession', () => {
    it('launches one browser and returns its first page as the control window', async () => {
        const { s, browsers, launcher } = session();
        const control = await s.launch();
        expect(launcher).toHaveBeenCalledTimes(1);
        expect(control).toBe(browsers[0]!.openPages[0]);
        expect(s.isOwnPage(control as never)).toBe(true);
        expect(s.isConnected()).toBe(true);
    });

    it('refuses to launch twice without closing', async () => {
        const { s } = session();
        await s.launch();
        await expect(s.launch()).rejects.toThrow('already running');
    });

    it('opens workers as new windows of the same browser, not tabs or new browsers', async () => {
        const { s, browsers, launcher } = session();
        await s.launch();
        const a = await s.openWindow();
        const b = await s.openWindow();
        await flush();
        expect(launcher).toHaveBeenCalledTimes(1);
        expect(browsers[0]!.windowsOpened).toBe(2);
        expect(a).not.toBe(b);
        expect(s.isOwnPage(a)).toBe(true);
        expect(s.isOwnPage(b)).toBe(true);
        // Its own windows survive the new-page handler.
        expect((a as unknown as FakePage).closed).toBe(false);
        expect((b as unknown as FakePage).closed).toBe(false);
    });

    it('closes a pop-up the crawled app opens, but never its own windows', async () => {
        const { s, browsers } = session();
        const control = await s.launch();
        const worker = await s.openWindow();
        const popup = browsers[0]!.openPopup();
        await flush();
        expect(popup.closed).toBe(true);
        expect((control as unknown as FakePage).closed).toBe(false);
        expect((worker as unknown as FakePage).closed).toBe(false);
    });

    it('closes a pop-up even when the browser has only one other page (the old rule left that case alone)', async () => {
        const { s, browsers } = session();
        await s.launch();
        await s.closeWindow(browsers[0]!.openPages[0]! as never);
        const popup = browsers[0]!.openPopup();
        await flush();
        expect(popup.closed).toBe(true);
    });

    it('closeWindow closes one window and leaves the browser running', async () => {
        const { s, browsers } = session();
        await s.launch();
        const worker = await s.openWindow();
        await s.closeWindow(worker);
        expect((worker as unknown as FakePage).closed).toBe(true);
        expect(s.isOwnPage(worker)).toBe(false);
        expect(browsers[0]!.closeCalls).toBe(0);
        expect(s.isConnected()).toBe(true);
    });

    it('reports a crash, but not its own close', async () => {
        const { s, browsers, onCrash } = session();
        await s.launch();
        await s.close();
        expect(onCrash).not.toHaveBeenCalled();
        expect(browsers[0]!.closeCalls).toBe(1);

        await s.launch();
        browsers[1]!.crash();
        expect(onCrash).toHaveBeenCalledTimes(1);
        expect(onCrash).toHaveBeenCalledWith(s);
        expect(s.isConnected()).toBe(false);
    });

    it('ignores a late disconnect from a browser it already replaced', async () => {
        const { s, browsers, onCrash } = session();
        await s.launch();
        await s.close();
        await s.launch();
        browsers[0]!.emit('disconnected');
        expect(onCrash).not.toHaveBeenCalled();
    });

    it('close is safe to repeat and on a session that never launched', async () => {
        const { s, browsers } = session();
        await s.close();
        await s.launch();
        await s.close();
        await s.close();
        expect(browsers[0]!.closeCalls).toBe(1);
        expect(() => s.requireBrowser()).toThrow('not running');
        await expect(s.openWindow()).rejects.toThrow('not running');
    });

    describe('profile cleanup', () => {
        it('deletes the profile Sasori made when the browser closes', async () => {
            const dir = tempDir();
            mkdirSync(join(dir, 'Default'));
            writeFileSync(join(dir, 'Default', 'cert9.db'), 'x');
            const { s } = session(dir);
            await s.launch();
            expect(existsSync(dir)).toBe(true);
            await s.close();
            expect(existsSync(dir)).toBe(false);
        });

        it('deletes it after a crash too, on the close that follows', async () => {
            const dir = tempDir();
            const { s, browsers } = session(dir);
            await s.launch();
            browsers[0]!.crash();
            await s.close();
            expect(existsSync(dir)).toBe(false);
        });
    });
});

describe('removeUserDataDir', () => {
    it('ignores empty input and a directory that is already gone', () => {
        expect(() => removeUserDataDir(null)).not.toThrow();
        expect(() => removeUserDataDir('')).not.toThrow();
        expect(() => removeUserDataDir(join(tmpdir(), 'sasori-does-not-exist-xyz'))).not.toThrow();
    });
});
