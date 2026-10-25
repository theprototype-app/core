// 75 MU1: Web MIDI input with no browser — the message parser, the note names, and the
// permission rule: core never asks the browser at boot; a reload reconnects silently only
// when this browser connected before AND the permission already says 'granted'.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { parseMidi, noteName, resumeMidiIfGranted, enableMidi, disableMidi, midiState, midiDebug } from '../../src/lib/midiInput.js';
import { safeStorage } from '../../src/lib/safeStorage.js';

describe('parseMidi', () => {
	it('reads note on / off, with velocity 0 as an off', () => {
		expect(parseMidi([0x90, 60, 127])).toMatchObject({ type: 'noteon', channel: 1, note: 60, velocity: 1 });
		expect(parseMidi([0x93, 64, 0])).toMatchObject({ type: 'noteoff', channel: 4, note: 64, velocity: 0 });
		expect(parseMidi([0x8f, 36, 40])).toMatchObject({ type: 'noteoff', channel: 16, note: 36 });
	});
	it('reads controllers, pitch bend and aftertouch on a 0..1 / -1..1 scale', () => {
		expect(parseMidi([0xb0, 64, 127])).toMatchObject({ type: 'cc', controller: 64, value: 1 });
		expect(parseMidi([0xe0, 0x00, 0x40])).toMatchObject({ type: 'pitchbend', value: 0 });
		expect(parseMidi([0xe0, 0x7f, 0x7f])?.value).toBeCloseTo(1, 6);
		expect(parseMidi([0xe0, 0x00, 0x00])?.value).toBe(-1);
		expect(parseMidi([0xd0, 127])).toMatchObject({ type: 'aftertouch', value: 1 });
		expect(parseMidi([0xa0, 60, 0])).toMatchObject({ type: 'aftertouch', note: 60, value: 0 });
	});
	it('system messages are other; data with no status is nothing', () => {
		expect(parseMidi([0xf8])?.type).toBe('other');
		expect(parseMidi([0x40, 0x40])).toBeNull();
		expect(parseMidi([])).toBeNull();
		expect(parseMidi(new Uint8Array([0x90, 61, 64]))?.velocity).toBeCloseTo(64 / 127, 9);
	});
});

describe('noteName', () => {
	it('names middle C C4 and wraps octaves', () => {
		expect(noteName(60)).toBe('C4');
		expect(noteName(69)).toBe('A4');
		expect(noteName(61)).toBe('C♯4');
		expect(noteName(0)).toBe('C-1');
		expect(noteName(127)).toBe('G9');
	});
});

describe('the permission rule', () => {
	/** @type {any} */ let request;
	/** @type {string} */ let permission;
	const nav = /** @type {any} */ (globalThis).navigator;
	beforeEach(() => {
		permission = 'prompt';
		request = vi.fn(async () => ({ inputs: new Map([['in1', { id: 'in1', name: 'Test keys', manufacturer: 'T', state: 'connected' }]]), onstatechange: null }));
		Object.defineProperty(globalThis, 'navigator', {
			configurable: true,
			value: { requestMIDIAccess: request, permissions: { query: async () => ({ state: permission }) } }
		});
		disableMidi();
		safeStorage.removeItem('midiInput');
	});
	afterEach(() => {
		disableMidi();
		safeStorage.removeItem('midiInput');
		Object.defineProperty(globalThis, 'navigator', { configurable: true, value: nav });
	});

	it('a first boot asks nothing', async () => {
		expect(await resumeMidiIfGranted()).toBe(false);
		expect(request).not.toHaveBeenCalled();
	});
	it('a boot after a connect, with the permission still at prompt, asks nothing', async () => {
		safeStorage.setItem('midiInput', '1');
		permission = 'prompt';
		expect(await resumeMidiIfGranted()).toBe(false);
		expect(request).not.toHaveBeenCalled();
	});
	it('a boot after a connect, with the permission granted, reconnects silently', async () => {
		safeStorage.setItem('midiInput', '1');
		permission = 'granted';
		expect(await resumeMidiIfGranted()).toBe(true);
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0][0]).toEqual({ sysex: false });
		expect(get(midiState).inputs.map((i) => i.name)).toEqual(['Test keys']);
	});
	it('a disconnect is remembered: the next boot does not reconnect', async () => {
		await enableMidi();
		disableMidi();
		permission = 'granted';
		expect(await resumeMidiIfGranted()).toBe(false);
		expect(midiDebug().connected).toBe(false);
	});
	it('a refusal reads as denied, not as an error', async () => {
		request.mockImplementationOnce(async () => {
			throw Object.assign(new Error('nope'), { name: 'NotAllowedError' });
		});
		expect(await enableMidi()).toBe('denied');
		expect(get(midiState).status).toBe('denied');
	});
	it('no Web MIDI = unsupported, nothing thrown', async () => {
		Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
		expect(await enableMidi()).toBe('unsupported');
		expect(await resumeMidiIfGranted()).toBe(false);
	});
});
