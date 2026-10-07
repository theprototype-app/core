// 37 R26: "one gesture = ONE undo step" for every scrub field, without each consumer
// bracketing its own writes. A gesture is a token (any object); history entries recorded
// while one is current carry it, and history.js folds an entry into the stack top when
// both share the token (history.js `mergeGestureEntry`). DragRow opens one per scrub and
// one per typing session (focus -> Enter / Escape / blur), so the arrows, the keystrokes
// and an Escape revert of one edit are one step — and a revert that lands back where it
// started leaves no step at all.
//
// A LEAF on purpose (imports nothing): DragRow is a UI part that also renders outside the
// app (the /kit page), and history.js sits in the import-cycle family (CLAUDE.md).
//
// Consumers that record LATER than the change (a debounced recorder, like the Inspector's
// 500 ms transform seal) capture `currentHistoryGesture()` when the change happens and
// record inside `withHistoryGesture(token, ...)`.

/** @type {object|null} */
let current = null;

/** The gesture an entry recorded right now belongs to, or null. */
export function currentHistoryGesture() {
	return current;
}

/**
 * Run `fn` with `token` as the current gesture (null = none). Nests: the outer gesture
 * comes back afterwards, even when `fn` throws.
 * @template T @param {object|null} token @param {() => T} fn @returns {T}
 */
export function withHistoryGesture(token, fn) {
	const prev = current;
	current = token;
	try {
		return fn();
	} finally {
		current = prev;
	}
}
