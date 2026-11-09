// 78 F26 — "WHY DID THIS NOT FIRE?": each trigger node (On Enter / On Exit / On Hover / On Click /
// Collect pickup / Timer) keeps its LAST CHECK — when, who or what was tested, and whether it fired
// or what blocked it — and a STANDING reason when nothing can reach it right now (Edit mode, physics
// not running, no object to watch, no sensor, "enabled" off). The node card shows one line (78 F7's
// live-state line) and the Flow debugger shows the full sentence for the focused node.
//
// A LEAF (imports nothing): flowRuntime writes the checks at its decision points and computes the
// standing reason (it holds the runtime facts); nothing here is sent — a check is what THIS peer
// saw, which is the point (an On Enter on a joiner says the physics runs on another peer).

/** the node types that keep a check */
export const WHY_TYPES = new Set(['onenter', 'onexit', 'onhover', 'onclick', 'kit-pickups-collect', 'timer']);

/** reason key -> plain words (one line; the card cuts at 40 characters) */
export const WHY_REASONS = /** @type {const} */ ({
	edit: 'in Edit mode (use Play)',
	'no-sim': 'physics is not running',
	authority: 'checked on the physics peer',
	'no-target': 'no object to watch',
	'no-sensor': 'its object is not a sensor',
	'not-player': 'not the player',
	'not-objects': 'the player (wants objects)',
	filter: 'the filter did not match',
	cooldown: 'still in its cooldown',
	disabled: '"enabled" is off',
	'not-me': 'another player (who: me)',
	muted: 'its object is muted',
	'touch-off': 'touch off, nothing wired',
	refused: 'refused',
	'nothing-wired': 'nothing wired into it'
});

/** @typedef {keyof typeof WHY_REASONS} WhyReason */
/** @typedef {{at: number, who: string, fired: boolean, reason: WhyReason | null, detail: string}} WhyCheck */

/** node id -> its last check @type {Map<string, WhyCheck>} */
const checks = new Map();

/**
 * Record a check on a trigger node. `at` is wall-clock ms (Date.now) — the card says "1.2 s ago".
 * @param {string} nodeId
 * @param {{who?: string, fired?: boolean, reason?: WhyReason | null, detail?: string, at?: number}} check
 */
export function noteCheck(nodeId, check) {
	if (!nodeId) return;
	checks.set(nodeId, {
		at: typeof check.at === 'number' ? check.at : Date.now(),
		who: String(check.who ?? '').slice(0, 40),
		fired: !!check.fired,
		reason: check.fired ? null : (check.reason ?? null),
		detail: String(check.detail ?? '').slice(0, 80)
	});
}

/** @param {string} nodeId @returns {WhyCheck | null} */
export function lastCheck(nodeId) {
	return checks.get(nodeId) ?? null;
}

/** forget every check (a scene clear / load) */
export function clearChecks() {
	checks.clear();
}

/** debug / suites: {nodeId: check} */
export function whyDebug() {
	return Object.fromEntries(checks);
}

/** "0.4 s ago" / "12 s ago" / "3 min ago" @param {number} ms */
export function agoText(ms) {
	if (!Number.isFinite(ms) || ms < 0) ms = 0;
	const s = ms / 1000;
	if (s < 10) return `${s.toFixed(1)} s ago`;
	if (s < 120) return `${Math.round(s)} s ago`;
	return `${Math.round(s / 60)} min ago`;
}

/** the words for a check's block @param {WhyCheck} check */
function reasonText(check) {
	const words = check.reason ? WHY_REASONS[check.reason] : 'did not fire';
	return check.detail && check.reason === 'refused' ? `refused: ${check.detail}` : words;
}

/** how long a fresh check outranks a standing reason on the card (ms) */
export const FRESH_MS = 10000;

/**
 * The card's line. A check inside the last 10 s wins ("blocked: not the player", "fired 0.4 s ago");
 * otherwise a standing reason ("won't fire: Edit mode…"); otherwise the older check; null = nothing
 * to say (the card falls back to its plain "fired" line).
 * @param {WhyCheck | null} check @param {WhyReason | null} standing @param {number} [now]
 * @returns {string | null}
 */
export function whyCardLine(check, standing, now = Date.now()) {
	const age = check ? now - check.at : Infinity;
	if (check && age <= FRESH_MS) return check.fired ? `fired ${agoText(age)}` : `blocked: ${reasonText(check)}`;
	if (standing) return `won't fire: ${WHY_REASONS[standing]}`;
	if (check) return check.fired ? `fired ${agoText(age)}` : `blocked ${agoText(age)}`;
	return null;
}

/**
 * The debugger's full sentence for one node: the last check (time, who, fired or why not) and the
 * standing reason, each on its own line.
 * @param {WhyCheck | null} check @param {WhyReason | null} standing @param {number} [now]
 * @returns {{last: string, standing: string | null}}
 */
export function whySentence(check, standing, now = Date.now()) {
	let last = 'No check yet: nothing has reached it on this device.';
	if (check) {
		const who = check.who ? ` · ${check.who}` : '';
		last = check.fired ? `Last check ${agoText(now - check.at)}${who}: fired.` : `Last check ${agoText(now - check.at)}${who}: blocked, ${reasonText(check)}.`;
	}
	return { last, standing: standing ? `Right now it cannot fire: ${WHY_REASONS[standing]}.` : null };
}
