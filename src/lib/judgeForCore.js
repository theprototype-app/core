// 103 H11 — "JUDGE FOR", the pure half (imports nothing; tests/unit/judgeForCore.test.js).
//
// The Preview pill shows one part per device a person chose to judge the scene for: This device, Phone,
// Quest, PC — independent toggles, all off by default. Each maps onto one of the budget meter's three
// targets (perf/budgets.json: quest | phone | desktop); "This device" maps onto whichever of them this
// device is. LOCAL (this device's storage), never in a scene, never sent.

/** the toggles, in menu and pill order */
export const JUDGE_IDS = /** @type {const} */ (['this', 'phone', 'quest', 'pc']);
/** @typedef {typeof JUDGE_IDS[number]} JudgeId */

export const JUDGE_LABEL = /** @type {Record<string, string>} */ ({ this: 'This device', phone: 'Phone', quest: 'Quest', pc: 'PC' });
/** Lucide names (no emoji anywhere in the UI) */
export const TARGET_ICON = /** @type {Record<string, string>} */ ({ phone: 'smartphone', quest: 'glasses', desktop: 'monitor' });

/** a stored list made safe: known ids, no repeats, in JUDGE_IDS order @param {unknown} v @returns {JudgeId[]} */
export function normalizeJudge(v) {
	if (!Array.isArray(v)) return [];
	return JUDGE_IDS.filter((id) => v.includes(id));
}

/**
 * The first read of the toggle set on this device. A stored set wins. Otherwise the 46 B1 single target
 * migrates: 'phone' / 'desktop' were a person's own pick and become that toggle; 'quest' was the default
 * the old chip wrote for everyone on its first render, so it cannot be told from "never chose" and reads
 * as nothing toggled (never auto-toggle Quest — most templates are over its budget).
 * @param {string | null} stored the JSON of the set, or null @param {string | null} legacy the old `budgetTarget`
 * @returns {JudgeId[]}
 */
export function initialJudge(stored, legacy) {
	if (stored != null) {
		try {
			return normalizeJudge(JSON.parse(stored));
		} catch {
			return [];
		}
	}
	if (legacy === 'phone') return ['phone'];
	if (legacy === 'desktop') return ['pc'];
	return [];
}

/**
 * The meter target a toggle judges against.
 * @param {JudgeId} id @param {'quest' | 'phone' | 'desktop'} here this device's own target
 * @returns {'quest' | 'phone' | 'desktop'}
 */
export function targetOf(id, here) {
	return id === 'this' ? here : id === 'pc' ? 'desktop' : id;
}

/** this device as a meter target @param {{headset: boolean, deviceClass: string}} f */
export function hereTarget(f) {
	if (f.headset) return 'quest';
	return f.deviceClass === 'desktop' ? 'desktop' : 'phone';
}

/**
 * The pill's parts: one per toggled device, deduped by target (This device on a PC with PC also on is one
 * part, not the same number twice), in toggle order.
 * @param {JudgeId[]} on @param {'quest' | 'phone' | 'desktop'} here
 * @returns {{id: JudgeId, target: 'quest' | 'phone' | 'desktop'}[]}
 */
export function judgeParts(on, here) {
	/** @type {{id: JudgeId, target: any}[]} */
	const out = [];
	for (const id of normalizeJudge(on)) {
		const target = targetOf(id, here);
		if (!out.some((p) => p.target === target)) out.push({ id, target });
	}
	return out;
}

/**
 * The once-only auto-on: "This device" switches itself on the first time the scene goes over 100 % for
 * this device — and never again once it has, or once the person has touched the toggle at all.
 * @param {{on: JudgeId[], percent: number, spent: boolean}} s @returns {boolean}
 */
export function shouldAutoOn(s) {
	return !s.spent && !s.on.includes('this') && s.percent > 100;
}

/**
 * The collapse (row 15): too wide for its place, the parts fold to the worst one plus "+N".
 * @param {{target: string, percent: number}[]} parts @returns {{worst: number, more: number}}
 */
export function collapseParts(parts) {
	let worst = 0;
	for (let i = 1; i < parts.length; i++) if (parts[i].percent > parts[worst].percent) worst = i;
	return { worst, more: Math.max(0, parts.length - 1) };
}
