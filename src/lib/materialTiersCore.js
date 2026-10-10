// 40 F16 — THE LOOK TIER, the pure half (no THREE, no DOM, no stores — unit-tested).
//
// Some material features cost a device more than it can pay: TRANSMISSION renders the whole
// opaque scene a second time into a texture (one extra full pass per frame), and the THIN-FILM
// (iridescence) and SHEEN terms add a heavy block to every lit pixel. A desktop pays for both; a
// phone drops the pass; a headset — 2 × 1832² at 72-120 Hz — drops the per-pixel terms too.
//
// The tier is a fact about THIS device right now, decided from the same signals the water tier
// reads (WebXR presenting, the quality governor's overrides) — never a preference written into
// the scene. What a tier changes is applied LOCALLY on the live material; the authored numbers
// travel beside it (materialTiers.js), so a save, a preset snapshot or a peer always sees the
// look the author picked.

/** the material fields a tier may lower, cheapest-to-keep last */
export const TIERED_FIELDS = ['transmission', 'sheen', 'iridescence'];

/** what each tier keeps: `high` everything, `mid` all but the extra pass, `low` none of them */
const KEEP = {
	high: new Set(TIERED_FIELDS),
	mid: new Set(['sheen', 'iridescence']),
	low: new Set()
};

/**
 * The tier for this device now. Mirrors water's rule so the two never disagree about what a
 * phone is: a headset is `low`; the governor's "post off" step is `low`; a phone's start (AO
 * off, resolution under 80 %) is `mid`; otherwise `high`.
 * @param {{xr?: boolean, overrides?: {postOff?: boolean, aoOff?: boolean, dprScale?: number} | null, pin?: 'high'|'mid'|'low'|null}} s
 * @returns {'high'|'mid'|'low'}
 */
export function lookTier(s) {
	if (s?.pin === 'high' || s?.pin === 'mid' || s?.pin === 'low') return s.pin;
	if (s?.xr) return 'low';
	const o = s?.overrides ?? {};
	if (o.postOff) return 'low';
	if (o.aoOff || (typeof o.dprScale === 'number' && o.dprScale < 0.8)) return 'mid';
	return 'high';
}

/**
 * The value a field is DRAWN with on a tier, from its authored value.
 * @param {string} field @param {number} authored @param {'high'|'mid'|'low'} tier
 */
export function tieredValue(field, authored, tier) {
	if (!TIERED_FIELDS.includes(field)) return authored;
	const keep = KEEP[tier] ?? KEEP.high;
	return keep.has(field) ? authored : 0;
}

/**
 * Plan one material's tier pass. `current` = what the live material holds, `authored` = the
 * record beside it (or null), `written` = what this pass wrote last time (or null). A field
 * whose live value is not what we wrote was EDITED since (an Inspector change, a peer's
 * material message): that edit is the new authored value.
 * @param {Record<string, number>} current @param {Record<string, number> | null} authored
 * @param {Record<string, number> | null} written @param {'high'|'mid'|'low'} tier
 * @returns {{authored: Record<string, number>, draw: Record<string, number>, lowers: boolean}}
 */
export function planTier(current, authored, written, tier) {
	/** @type {Record<string, number>} */
	const next = {};
	/** @type {Record<string, number>} */
	const draw = {};
	let lowers = false;
	for (const f of TIERED_FIELDS) {
		const cur = typeof current[f] === 'number' ? current[f] : 0;
		let a;
		if (written && typeof written[f] === 'number' && cur !== written[f]) a = cur; // edited since
		else if (authored && typeof authored[f] === 'number') a = authored[f];
		else a = cur;
		next[f] = a;
		draw[f] = tieredValue(f, a, tier);
		if (draw[f] !== a) lowers = true;
	}
	return { authored: next, draw, lowers };
}
