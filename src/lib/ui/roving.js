// 38 R3 — keyboard movement for the redesign's single-choice primitives (Segmented, Tabs).
//
// WAI-ARIA radiogroup / tablist: ONE stop in the tab order (the selected item), and the
// arrow keys move — and, for both of ours, SELECT, because a segmented control and a tab
// strip both act on selection ("automatic activation"). Disabled items are skipped and the
// ends wrap. Pure, imports nothing: tests/unit/roving.test.js.

/** keys this module answers; anything else is the caller's */
export const ROVING_KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];

/**
 * The index a key moves to, or -1 when it does not move (not a roving key, nothing enabled).
 * @param {number} current index of the item that has focus (or the selected one)
 * @param {string} key KeyboardEvent.key
 * @param {boolean[]} disabled one flag per item
 * @param {'horizontal'|'vertical'|'both'} [orientation] which arrows move ('both' for radiogroups)
 * @returns {number}
 */
export function rovingIndex(current, key, disabled, orientation = 'both') {
	const n = disabled.length;
	if (!n || disabled.every(Boolean)) return -1;
	const fwd = orientation === 'horizontal' ? ['ArrowRight'] : orientation === 'vertical' ? ['ArrowDown'] : ['ArrowRight', 'ArrowDown'];
	const back = orientation === 'horizontal' ? ['ArrowLeft'] : orientation === 'vertical' ? ['ArrowUp'] : ['ArrowLeft', 'ArrowUp'];
	/** first enabled index walking from `start` by `step` (wrapping), inclusive of start */
	const walk = (/** @type {number} */ start, /** @type {number} */ step) => {
		for (let i = 0, j = start; i < n; i++, j = (j + step + n) % n) if (!disabled[j]) return j;
		return -1;
	};
	if (key === 'Home') return walk(0, 1);
	if (key === 'End') return walk(n - 1, -1);
	const from = current >= 0 && current < n ? current : 0;
	if (fwd.includes(key)) return walk((from + 1) % n, 1);
	if (back.includes(key)) return walk((from - 1 + n) % n, -1);
	return -1;
}
