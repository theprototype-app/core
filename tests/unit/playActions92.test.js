// 92-input GC3: the pad's play actions, its family glyphs, the key-hint code, and the one capture core.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PAD_ACTIONS, PAD_FOR_KEY, padFamily, padButtonName, padGlyph, padControlLines, hintCodeOf } from '../../src/lib/playActions.js';
import { captureInput, captureConflict } from '../../src/lib/keyCapture.js';
import { assignRemap } from '../../src/lib/playerAccessCore.js';
import { GAMEPAD_BUTTONS } from '../../src/lib/gamepadPrefs.js';

describe('the pad actions', () => {
	it('every built-in action sits on its own real pad button and does something', () => {
		const pads = PAD_ACTIONS.map((a) => a.pad);
		expect(new Set(pads).size).toBe(pads.length);
		for (const a of PAD_ACTIONS) {
			expect(GAMEPAD_BUTTONS).toContain(a.pad);
			expect((a.keys?.length ?? 0) + (a.pointer ? 1 : 0)).toBeGreaterThan(0);
		}
		expect(PAD_FOR_KEY.Space).toBe('GamepadA');
		expect(PAD_FOR_KEY.Escape).toBe('GamepadStart');
		// the moment button (Select) and the D-pad (the HUD ring) stay free
		expect(pads).not.toContain('GamepadSelect');
		expect(pads.some((p) => /Up|Down|Left|Right$/.test(p))).toBe(false);
	});
	it('the pad family from its id: vendor ids first, then names', () => {
		expect(padFamily('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe('playstation');
		expect(padFamily('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')).toBe('xbox');
		expect(padFamily('057e-2009-Pro Controller')).toBe('nintendo');
		expect(padFamily('Some Pad')).toBe('generic');
		expect(padFamily(null)).toBe('generic');
	});
	it('a button as each family prints it, and its glyph', () => {
		expect(padButtonName('GamepadA', 'xbox')).toBe('A');
		expect(padButtonName('GamepadA', 'playstation')).toBe('Cross');
		expect(padButtonName('GamepadA', 'nintendo')).toBe('B'); // the bottom button
		expect(padButtonName('GamepadR2', 'playstation')).toBe('R2');
		expect(padButtonName('GamepadStart', 'xbox')).toBe('Menu');
		expect(padButtonName('GamepadUp', 'xbox')).toBe('D-pad up');
		expect(padGlyph('GamepadY', 'playstation').shape).toBe('triangle');
		expect(padGlyph('GamepadY', 'xbox')).toEqual({ shape: 'face', text: 'Y' });
		expect(padGlyph('GamepadL1', 'xbox')).toEqual({ shape: 'shoulder', text: 'LB' });
		expect(padGlyph('GamepadLeft').dir).toBe('left');
		expect(padControlLines('playstation').join(' ')).toMatch(/Jump: Cross .*Menu: Options/);
	});
	it("a key hint's game code: the code field, else a key name that names a key, else none", () => {
		expect(hintCodeOf('', 'E')).toBe('KeyE');
		expect(hintCodeOf(undefined, 'space')).toBe('Space');
		expect(hintCodeOf('', 'Esc')).toBe('Escape');
		expect(hintCodeOf('', '3')).toBe('Digit3');
		expect(hintCodeOf('GamepadA', 'E')).toBe('GamepadA');
		expect(hintCodeOf('', 'Gamepad B')).toBe('GamepadB');
		expect(hintCodeOf('', 'LMB')).toBe(null); // shown as typed
		expect(hintCodeOf('nonsense', '')).toBe(null);
	});
});

describe('captureConflict (the note a swap shows)', () => {
	it('names the binding the key is taken from — the same rule the swap uses', () => {
		const bound = ['KeyW', 'KeyS', 'Space', 'KeyC'];
		expect(captureConflict({}, 'Space', 'KeyC', bound)).toBe('KeyC');
		expect(captureConflict({}, 'Space', 'KeyX', bound)).toBe(null);
		expect(captureConflict({ KeyW: 'ArrowUp' }, 'Space', 'ArrowUp', bound)).toBe('KeyW');
		expect(captureConflict({}, 'Space', 'Space', bound)).toBe(null);
		// and the swap really moves the other one to the old key
		const t = assignRemap({}, 'Space', 'KeyC', bound);
		expect(t).toEqual({ Space: 'KeyC', KeyC: 'Space' });
	});
});

describe('captureInput (the one capture)', () => {
	/** @type {Map<string, Function[]>} */
	let listeners;
	/** @type {any[]} */
	let pads;
	/** @type {Function[]} */
	let frames;
	beforeEach(() => {
		listeners = new Map();
		pads = [];
		frames = [];
		vi.stubGlobal('window', {
			addEventListener: (/** @type {string} */ t, /** @type {Function} */ f) => listeners.set(t, [...(listeners.get(t) ?? []), f]),
			removeEventListener: (/** @type {string} */ t, /** @type {Function} */ f) => listeners.set(t, (listeners.get(t) ?? []).filter((x) => x !== f))
		});
		vi.stubGlobal('navigator', { getGamepads: () => pads });
		vi.stubGlobal('requestAnimationFrame', (/** @type {Function} */ f) => frames.push(f));
		vi.stubGlobal('cancelAnimationFrame', () => {});
	});
	afterEach(() => vi.unstubAllGlobals());
	const key = (/** @type {string} */ code) => {
		const e = { code, preventDefault() {}, stopPropagation() {} };
		for (const f of listeners.get('keydown') ?? []) f(e);
	};
	const frame = () => frames.splice(0).forEach((f) => f());
	const padWith = (/** @type {number[]} */ down) => [{ connected: true, buttons: GAMEPAD_BUTTONS.map((_, i) => ({ pressed: down.includes(i), value: down.includes(i) ? 1 : 0 })) }];

	it('Escape cancels, a bare modifier waits unless allowed, a reserved key is refused with a reason', async () => {
		let c = captureInput({});
		key('ShiftLeft');
		key('Escape');
		expect(await c.done).toEqual({ cancelled: true });
		expect(listeners.get('keydown')).toEqual([]);
		/** @type {string[]} */
		const refused = [];
		c = captureInput({ bareModifiers: true, reserved: new Set(['Tab']), onRefuse: (k) => refused.push(k) });
		key('Tab');
		key('ShiftLeft');
		expect(await c.done).toEqual({ code: 'ShiftLeft' });
		expect(refused).toEqual(['Tab']);
		c = captureInput({ clearable: true, combo: () => 'Ctrl+K' });
		key('Backspace');
		expect(await c.done).toEqual({ clear: true });
		c = captureInput({ combo: () => 'Ctrl+K' });
		key('KeyK');
		expect(await c.done).toEqual({ code: 'KeyK', combo: 'Ctrl+K' });
	});
	it('a pad button counts on its down edge: the button still held from the press that opened it does not bind', async () => {
		pads = padWith([0]); // A is held (it pressed the row)
		const c = captureInput({ keys: false, pad: true, padButtons: GAMEPAD_BUTTONS });
		frame(); // first look: A was already down
		frame();
		pads = padWith([]); // A let go
		frame();
		pads = padWith([1]); // B
		frame();
		expect(await c.done).toEqual({ pad: 'GamepadB' });
	});
	it('cancel() ends it once', async () => {
		const c = captureInput({});
		c.cancel();
		c.cancel();
		key('KeyQ');
		expect(await c.done).toEqual({ cancelled: true });
	});
});
