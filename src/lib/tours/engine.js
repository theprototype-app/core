// 36 U3b/I5 — THE TOUR ENGINE (contract T1). One engine runs every first-run tour: the VR
// welcome, the desktop editor tour and its touch variant. It only knows steps and progress;
// HOW a step is shown (a 2D card spotlighting a `data-tour` element, or a world-space panel
// in a headset) is the surface's business — TourCard.svelte and the VR panel both render
// `active()` and call back into next/back/skip.
//
// A DELIBERATE LEAF: this file imports NOTHING (storage is injected), so the unit layer runs
// it with no browser. `index.js` binds it to safeStorage and a svelte store.
//
// THE STATES a tour can be in, persisted per tour id as `tour.<id>`:
//   absent        never started (a first-run trigger may auto-start it)
//   {at: n}       interrupted on step n (a reload, the headset taken off): RESUMABLE — the next
//                 auto-start or a manual start picks up there
//   'done'        finished, or Skip / Don't show again — never auto-starts again
// and ONE global switch, `toursAutoStart` ('false' = off): "Don't show again" turns it off,
// so no tour pops up by itself any more; Settings → Tours can turn it back on. A manual start
// (Settings, the logo menu, the radial) always works.
//
// ADVANCING: a step may name the action that completes it (`advanceOn`, one signal name or a
// list). Producers call `signal(name)` when the user does that thing — the VR input watcher,
// the editor — and the engine moves on if the CURRENT step waits for it. Next always works
// too, so a step can never trap anyone.

/**
 * @typedef {{
 *   id: string,
 *   title: string | (() => string),
 *   body: string | (() => string),
 *   target?: string,
 *   placement?: 'auto' | 'top' | 'bottom' | 'left' | 'right' | 'center',
 *   advanceOn?: string | string[],
 *   hint?: string | (() => string),
 *   controls?: Controls | (() => Controls),
 *   when?: () => boolean
 * }} TourStep
 * `target`: a `data-tour` id, or a CSS selector when it starts with one of `[.#`. `hint`: the
 * line that says what to DO ("Pull the trigger"). `controls`: the controller parts the VR
 * diagram lights up. `when`: the step only exists while it answers true (evaluated at start).
 * title/body/hint/controls may be functions (a hand that depends on a setting): `active()`
 * resolves them, so surfaces only ever see plain values.
 * @typedef {{hand: 'left' | 'right' | 'both', parts: string[]} | {left: string[], right: string[]}} Controls
 * @typedef {{id: string, title: string, body: string, target?: string, placement?: string,
 *   hint?: string, controls?: Controls, waiting: string[]}} ShownStep
 */
/**
 * @typedef {{title: string, surface?: 'card' | 'vr', steps: TourStep[]}} TourDef
 * @typedef {{id: string, title: string, surface: 'card' | 'vr', index: number, total: number,
 *   step: ShownStep, first: boolean, last: boolean, waiting: string[], preview: boolean}} ActiveTour
 * @typedef {{getItem: (k: string) => string | null, setItem: (k: string, v: string) => void,
 *   removeItem: (k: string) => void}} TourStorage
 */

export const AUTO_START_KEY = 'toursAutoStart';
/** @param {string} id */
export const progressKey = (id) => 'tour.' + id;

/**
 * @param {{storage: TourStorage, onChange?: (active: ActiveTour | null) => void}} options
 */
export function createTourEngine({ storage, onChange = () => {} }) {
	/** @type {Map<string, TourDef>} */
	const defs = new Map();
	/** `preview`: shown without touching its record (the VR welcome read on a screen)
	 * @type {{id: string, steps: TourStep[], index: number, preview: boolean} | null} */
	let current = null;
	/** signal counts, for the suites (which action advanced what) @type {Record<string, number>} */
	const signals = {};

	/** @param {string} key */
	function read(key) {
		try {
			return storage.getItem(key);
		} catch {
			return null;
		}
	}
	/** @param {string} key @param {string | null} value */
	function write(key, value) {
		try {
			if (value === null) storage.removeItem(key);
			else storage.setItem(key, value);
		} catch {
			/* storage is the injected safeStorage — it does not throw, a test double might */
		}
	}

	/** @param {string} id @returns {'new' | 'progress' | 'done'} */
	function status(id) {
		const raw = read(progressKey(id));
		if (!raw) return 'new';
		if (raw === 'done') return 'done';
		return 'progress';
	}
	/** the saved step index of an interrupted tour (0 when none) @param {string} id */
	function savedAt(id) {
		const raw = read(progressKey(id));
		if (!raw || raw === 'done') return 0;
		try {
			const at = JSON.parse(raw)?.at;
			return Number.isInteger(at) && at > 0 ? at : 0;
		} catch {
			return 0;
		}
	}

	/** @template T @param {T | (() => T)} v @returns {T | undefined} */
	function value(v) {
		try {
			return typeof v === 'function' ? /** @type {() => T} */ (v)() : v;
		} catch {
			return undefined;
		}
	}

	/** @returns {ActiveTour | null} */
	function active() {
		if (!current) return null;
		const def = /** @type {TourDef} */ (defs.get(current.id));
		const raw = current.steps[current.index];
		const waiting = raw.advanceOn ? [raw.advanceOn].flat() : [];
		/** @type {ShownStep} */
		const step = {
			id: raw.id,
			title: String(value(raw.title) ?? ''),
			body: String(value(raw.body) ?? ''),
			target: raw.target,
			placement: raw.placement,
			hint: raw.hint === undefined ? undefined : String(value(raw.hint) ?? ''),
			controls: value(raw.controls),
			waiting
		};
		return {
			id: current.id,
			title: def.title,
			surface: def.surface ?? 'card',
			index: current.index,
			total: current.steps.length,
			step,
			preview: current.preview,
			first: current.index === 0,
			last: current.index === current.steps.length - 1,
			waiting
		};
	}

	function emit() {
		try {
			onChange(active());
		} catch {
			/* a surface that throws must not wedge the engine */
		}
	}

	function saveProgress() {
		if (current && !current.preview) write(progressKey(current.id), JSON.stringify({ at: current.index }));
	}

	/** @param {string} id @param {TourDef} def */
	function register(id, def) {
		if (!id || !def || !Array.isArray(def.steps) || !def.steps.length) throw new Error('tours.register: a tour needs an id and steps');
		defs.set(id, { ...def, steps: def.steps.slice() });
		return () => {
			if (current?.id === id) close();
			defs.delete(id);
		};
	}

	/**
	 * Start (or resume) a tour. `from`: 'resume' (default — an interrupted tour picks up where
	 * it stopped) or 'start' (from the top). `preview`: show it without reading or writing its
	 * record. Starting a tour replaces any other running one.
	 * @param {string} id @param {{from?: 'resume' | 'start', preview?: boolean}} [options] @returns {boolean}
	 */
	function start(id, { from = 'resume', preview = false } = {}) {
		const def = defs.get(id);
		if (!def) return false;
		const steps = def.steps.filter((s) => {
			try {
				return s.when ? !!s.when() : true;
			} catch {
				return false;
			}
		});
		if (!steps.length) return false;
		const at = from === 'resume' && !preview ? Math.min(savedAt(id), steps.length - 1) : 0;
		current = { id, steps, index: at, preview };
		saveProgress();
		emit();
		return true;
	}

	/** Auto-start a first-run tour: only when it was never finished/skipped and auto-start is on.
	 * Resumes an interrupted one. Never interrupts another running tour. @param {string} id */
	function maybeAutoStart(id) {
		if (!defs.has(id) || current) return false;
		if (!autoStartEnabled()) return false;
		if (status(id) === 'done') return false;
		return start(id);
	}

	/** @param {number} index */
	function go(index) {
		if (!current) return;
		if (index < 0) index = 0;
		if (index >= current.steps.length) return finish();
		current.index = index;
		saveProgress();
		emit();
	}
	const next = () => current && go(current.index + 1);
	const back = () => current && go(current.index - 1);

	/** the end of the tour — it will not auto-start again */
	function finish() {
		if (!current) return;
		if (!current.preview) write(progressKey(current.id), 'done');
		current = null;
		emit();
	}
	/** Skip = I do not want this tour: same record as finishing it. */
	const skip = finish;
	/** Skip, AND no tour starts by itself any more (Settings can turn that back on). */
	function dontShowAgain() {
		if (current?.preview) return finish();
		write(AUTO_START_KEY, 'false');
		finish();
	}
	/** Hide without deciding (the headset came off, the page is going away): progress stays,
	 * so the tour resumes on its next trigger. */
	function close() {
		if (!current) return;
		saveProgress();
		current = null;
		emit();
	}

	/**
	 * The user did something. Advances the current step when it waits for exactly this.
	 * @param {string} name @returns {boolean} whether it advanced
	 */
	function signal(name) {
		signals[name] = (signals[name] ?? 0) + 1;
		const now = active();
		if (!now || !now.waiting.includes(name)) return false;
		next();
		return true;
	}

	/** Re-resolve the current step (its text/controls are functions of settings — a VR button remap
	 * mid-step must reach the surfaces, which only hear `onChange`). */
	function refresh() {
		if (current) emit();
	}

	/** @param {string} id */
	const seen = (id) => status(id) === 'done';
	/** forget one tour's record, or every registered one's @param {string} [id] */
	function reset(id) {
		const ids = id ? [id] : [...defs.keys()];
		for (const one of ids) write(progressKey(one), null);
		if (!id) write(AUTO_START_KEY, null);
	}
	function autoStartEnabled() {
		return read(AUTO_START_KEY) !== 'false';
	}
	/** @param {boolean} on */
	function setAutoStart(on) {
		write(AUTO_START_KEY, on ? null : 'false');
	}

	return {
		register,
		start,
		maybeAutoStart,
		next,
		back,
		skip,
		finish,
		dontShowAgain,
		close,
		refresh,
		signal,
		seen,
		status,
		reset,
		active,
		autoStartEnabled,
		setAutoStart,
		ids: () => [...defs.keys()],
		has: (/** @type {string} */ id) => defs.has(id),
		debug: () => ({ active: active(), signals: { ...signals }, ids: [...defs.keys()] })
	};
}
