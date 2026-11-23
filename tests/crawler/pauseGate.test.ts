/**
 * PauseGate — stopping workers between actions for a re-login (SCAN-236).
 */

import PauseGate from '../../src/crawler/pauseGate';

/** Lets pending promise callbacks run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('PauseGate', () => {
    it('lets workers through while not paused, and counts them', async () => {
        const gate = new PauseGate();
        expect(await gate.enter()).toBe(true);
        expect(await gate.enter()).toBe(true);
        expect(gate.busyCount()).toBe(2);
        gate.leave();
        gate.leave();
        expect(gate.busyCount()).toBe(0);
    });

    it('resolves pause at once when no action is running', async () => {
        const gate = new PauseGate();
        await expect(gate.pause()).resolves.toBeUndefined();
        expect(gate.isPaused()).toBe(true);
    });

    it('waits for every running action to finish before pause resolves', async () => {
        const gate = new PauseGate();
        await gate.enter();
        await gate.enter();
        let paused = false;
        const pausing = gate.pause().then(() => {
            paused = true;
        });

        await flush();
        expect(paused).toBe(false);
        gate.leave();
        await flush();
        expect(paused).toBe(false); // one action still running
        gate.leave();
        await pausing;
        expect(paused).toBe(true);
    });

    it('holds workers at enter while paused, and releases them on resume', async () => {
        const gate = new PauseGate();
        await gate.pause();
        let entered: boolean | null = null;
        const waiting = gate.enter().then((ok) => {
            entered = ok;
        });

        await flush();
        expect(entered).toBeNull();
        expect(gate.busyCount()).toBe(0);
        gate.resume();
        await waiting;
        expect(entered).toBe(true);
        expect(gate.busyCount()).toBe(1);
    });

    it('starts no new action between pause and resume', async () => {
        const gate = new PauseGate();
        await gate.enter();
        const pausing = gate.pause();
        const late = gate.enter();
        gate.leave();
        await pausing;
        expect(gate.busyCount()).toBe(0); // the late worker is still waiting
        gate.resume();
        expect(await late).toBe(true);
    });

    it('cancel releases waiting workers with false, and a pending pause', async () => {
        const gate = new PauseGate();
        await gate.enter();
        const pausing = gate.pause();
        const waiting = gate.enter();
        gate.cancel();
        await expect(pausing).resolves.toBeUndefined();
        await expect(waiting).resolves.toBe(false);
        await expect(gate.enter()).resolves.toBe(false);
    });

    it('does not go below zero on an extra leave', () => {
        const gate = new PauseGate();
        gate.leave();
        expect(gate.busyCount()).toBe(0);
    });
});
