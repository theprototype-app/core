// 103 H11 — "JUDGE FOR", the stores (the pure rules are ./judgeForCore.js). Imported by the Preview pill
// only, so it rides the pill's lazy chunk. LOCAL: safeStorage on this device, never a scene, never sent.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { deviceClass } from './deviceClass.js';
import { HEADSET_UA } from './cinematic/cinematicOffer.js';
import { initialJudge, normalizeJudge, hereTarget, shouldAutoOn } from './judgeForCore.js';

export const JUDGE_KEY = 'budget:judgeFor';
/** set once "This device" switched itself on, or the person touched it: the auto-on never runs again */
export const AUTO_KEY = 'budget:thisAuto';

function read() {
	try {
		return initialJudge(safeStorage.getItem(JUDGE_KEY), safeStorage.getItem('budgetTarget'));
	} catch {
		return [];
	}
}

/** the toggled devices @type {import('svelte/store').Writable<import('./judgeForCore.js').JudgeId[]>} */
export const judgeFor = writable(read());
// written from the first read on, so the migration happens once and a later budgetTarget pick in
// Statistics (that one stays the Budget section's own choice) never re-migrates
judgeFor.subscribe((v) => {
	try {
		safeStorage.setItem(JUDGE_KEY, JSON.stringify(normalizeJudge(v)));
	} catch {
		/* private mode: lasts the session */
	}
});

/** this device as a meter target */
export function here() {
	const ua = typeof navigator === 'undefined' ? '' : String(navigator.userAgent || '');
	return /** @type {'quest' | 'phone' | 'desktop'} */ (hereTarget({ headset: HEADSET_UA.test(ua), deviceClass: get(deviceClass) }));
}

function spent() {
	try {
		return safeStorage.getItem(AUTO_KEY) === '1';
	} catch {
		return true;
	}
}
function spend() {
	try {
		safeStorage.setItem(AUTO_KEY, '1');
	} catch {
		/* nothing to remember with */
	}
}

/** a person's own toggle @param {import('./judgeForCore.js').JudgeId} id */
export function toggleJudge(id) {
	if (id === 'this') spend(); // touched by hand: the auto-on is theirs now, never ours
	judgeFor.update((on) => normalizeJudge(on.includes(id) ? on.filter((x) => x !== id) : [...on, id]));
}

/** the meter's reading for this device, checked against the once-only rule @param {number} percent */
export function maybeAutoOn(percent) {
	const on = get(judgeFor);
	if (!shouldAutoOn({ on, percent, spent: spent() })) return false;
	spend();
	judgeFor.set(normalizeJudge([...on, 'this']));
	return true;
}
