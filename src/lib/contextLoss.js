// WHEN A LOST 3D VIEW IS WORTH SAYING ANYTHING ABOUT (a LEAF: imports nothing).
//
// A phone that minimises the browser, folds, or switches apps routinely takes the WebGL
// context away and hands it back a moment after the page is visible again. Showing "The 3D
// view has stopped" and filing an error report for that is noise: the person never saw the
// view stop. So the raw fact (`contextLost`, which the shader guard still reads at once) and
// the LOUD fact (`contextLossShown`, which drives the overlay and the error report) are two
// stores, and this rule decides the second from the first.
//
// THE RULE: a loss becomes loud only after the page has been VISIBLE for GRACE ms with the
// context still gone — counted from the later of the loss and the moment the page became
// visible. A loss while hidden that comes back within GRACE of the page showing again, or a
// visible loss restored within GRACE, says nothing. Hiding the page again stops the clock.

/** how long a lost context may stay lost on a visible page before the overlay shows */
export const CONTEXT_LOSS_GRACE_MS = 3000;

/**
 * @typedef {{ lost: boolean, loud: boolean, lostAt: number, visibleSince: number | null }} LossState
 * @typedef {'lost' | 'restored' | 'visible' | 'hidden' | 'tick'} LossEvent
 */

/** @param {number} now @param {boolean} visible @returns {LossState} */
export function lossInit(now, visible) {
	return { lost: false, loud: false, lostAt: 0, visibleSince: visible ? now : null };
}

/** When the pending loss turns loud, or null (nothing pending) @param {LossState} s */
export function lossDeadline(s) {
	if (!s.lost || s.loud || s.visibleSince === null) return null;
	return Math.max(s.lostAt, s.visibleSince) + CONTEXT_LOSS_GRACE_MS;
}

/**
 * One step of the rule. Pure.
 * @param {LossState} s @param {LossEvent} event @param {number} now @returns {LossState}
 */
export function lossStep(s, event, now) {
	let next = s;
	if (event === 'lost') next = s.lost ? s : { ...s, lost: true, loud: false, lostAt: now };
	else if (event === 'restored') next = { ...s, lost: false, loud: false };
	else if (event === 'hidden') next = { ...s, visibleSince: null };
	else if (event === 'visible') next = s.visibleSince === null ? { ...s, visibleSince: now } : s;
	const due = lossDeadline(next);
	if (due !== null && now >= due) next = { ...next, loud: true };
	return next;
}

let started = false;

/**
 * Drive `shown` from `lost` and the page's visibility. Idempotent.
 * @param {{ subscribe: (fn: (v: boolean) => void) => () => void }} lost
 * @param {{ set: (v: boolean) => void }} shown
 * @param {{ doc?: Document, now?: () => number }} [opts]
 */
export function startContextLossGate(lost, shown, opts = {}) {
	if (started) return;
	const doc = opts.doc ?? (typeof document !== 'undefined' ? document : null);
	if (!doc) return;
	started = true;
	const now = opts.now ?? (() => Date.now());
	const isVisible = () => doc.visibilityState !== 'hidden';
	let state = lossInit(now(), isVisible());
	/** @type {ReturnType<typeof setTimeout> | null} */
	let timer = null;
	/** @param {LossEvent} event */
	const step = (event) => {
		state = lossStep(state, event, now());
		shown.set(state.loud);
		if (timer) clearTimeout(timer);
		timer = null;
		const due = lossDeadline(state);
		if (due !== null) timer = setTimeout(() => step('tick'), Math.max(0, due - now()) + 20);
	};
	doc.addEventListener('visibilitychange', () => step(isVisible() ? 'visible' : 'hidden'));
	// a loss that lands a moment BEFORE the hide event is fine: 'hidden' stops its clock
	lost.subscribe((v) => step(v ? 'lost' : 'restored'));
}

/** test seam: forget the started flag */
export function resetContextLossGateForTest() {
	started = false;
}
