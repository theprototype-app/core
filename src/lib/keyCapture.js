// 92-input GC3 (Q6) — ONE KEY / BUTTON CAPTURE, for every "press the key you want" control. Before it the
// app had three hand-rolled copies (Settings ▸ Shortcuts, the command palette's rebind, the pause menu's
// Controls page), each with its own idea of what Escape, Backspace and a bare Shift mean. The player
// remap uses it here; the editor keymaps (ShortcutsSettings / CommandPalette, lanes 103-keys and
// 103-menu-palette) adopt it at their int — their combo strings come from the `combo` option.
//
// The rules, the same everywhere:
//   · Escape cancels (it is the way out of every capture, and never a binding)
//   · Backspace / Delete answers {clear: true} when `clearable` (a binding with no key)
//   · a bare modifier is ignored unless `bareModifiers` (an editor combo needs a key; a game may bind
//     Shift to sprint)
//   · a reserved key is refused with a reason (`reserved` map or set) and the capture keeps waiting
//   · a pad button counts on its DOWN EDGE only: the button that pressed the row (A on the HUD ring)
//     is still held when the capture starts and must not bind itself
// A LEAF (no imports): the pad's button list is passed in.

const MODIFIERS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

/**
 * @typedef {{code?: string, combo?: string, pad?: string, clear?: boolean, cancelled?: boolean}} CaptureResult
 * @typedef {{keys?: boolean, pad?: boolean, padButtons?: string[], clearable?: boolean, bareModifiers?: boolean,
 *   reserved?: Set<string> | Record<string, string>, combo?: (e: KeyboardEvent) => string,
 *   onRefuse?: (code: string, reason: string) => void}} CaptureOptions
 */

/** why a key is refused, or '' @param {CaptureOptions['reserved']} reserved @param {string} code */
function refusal(reserved, code) {
	if (!reserved) return '';
	if (reserved instanceof Set) return reserved.has(code) ? 'reserved' : '';
	return reserved[code] ?? '';
}

/**
 * Wait for the next key and / or pad button. Returns `{done, cancel}`: `done` resolves ONCE with the
 * result; `cancel()` resolves it with {cancelled: true} (a second press of the row, the page closing).
 * @param {CaptureOptions} [opts]
 * @returns {{done: Promise<CaptureResult>, cancel: () => void}}
 */
export function captureInput(opts = {}) {
	const wantKeys = opts.keys !== false;
	const wantPad = !!opts.pad;
	/** @type {(r: CaptureResult) => void} */
	let resolve = () => {};
	const done = /** @type {Promise<CaptureResult>} */ (new Promise((r) => (resolve = r)));
	let over = false;
	let raf = 0;
	/** @param {CaptureResult} r */
	const finish = (r) => {
		if (over) return;
		over = true;
		if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey, true);
		if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
		resolve(r);
	};
	/** capture phase: the press belongs to the capture, not to the game or the menu @param {KeyboardEvent} e */
	function onKey(e) {
		if (over) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.code === 'Escape') return finish({ cancelled: true });
		if (opts.clearable && (e.code === 'Backspace' || e.code === 'Delete')) return finish({ clear: true });
		if (!wantKeys) return;
		if (MODIFIERS.has(e.code) && !opts.bareModifiers) return;
		const why = refusal(opts.reserved, e.code);
		if (why) {
			opts.onRefuse?.(e.code, why);
			return;
		}
		finish({ code: e.code, ...(opts.combo ? { combo: opts.combo(e) } : {}) });
	}
	if (typeof window !== 'undefined') window.addEventListener('keydown', onKey, true);
	if (wantPad && typeof requestAnimationFrame === 'function') {
		const names = opts.padButtons ?? [];
		/** buttons already down when the capture began (the press that opened it) @type {Set<number>} */
		let wasDown = new Set();
		let first = true;
		const poll = () => {
			if (over) return;
			const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? [...navigator.getGamepads()] : [];
			const pad = pads.find((p) => p && p.connected !== false);
			/** @type {Set<number>} */
			const down = new Set();
			pad?.buttons?.forEach((b, i) => {
				if (b && (b.pressed || (typeof b.value === 'number' && b.value > 0.5))) down.add(i);
			});
			if (first) {
				wasDown = down;
				first = false;
			} else {
				for (const i of down) {
					if (wasDown.has(i) || !names[i]) continue;
					const why = refusal(opts.reserved, names[i]);
					if (why) {
						opts.onRefuse?.(names[i], why);
						continue;
					}
					return finish({ pad: names[i] });
				}
				// a button let go may be pressed again as the answer
				for (const i of [...wasDown]) if (!down.has(i)) wasDown.delete(i);
			}
			raf = requestAnimationFrame(poll);
		};
		raf = requestAnimationFrame(poll);
	}
	return { done, cancel: () => finish({ cancelled: true }) };
}

/**
 * The binding a new key would take over, or null — for the conflict note ("Crouch moved to C"). The
 * same rule the swap uses (playerAccessCore.assignRemap): the binding whose key it is now, remapped or
 * not. Pure. @param {Record<string, string>} table game -> player code @param {string} game
 * @param {string} player @param {Iterable<string>} [bound] every game code listed
 * @returns {string | null} the other game code
 */
export function captureConflict(table, game, player, bound = []) {
	for (const g in table) if (table[g] === player && g !== game) return g;
	if (!(player in table) && player !== game && new Set(bound).has(player)) return player;
	return null;
}
