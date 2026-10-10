// 40 F12 — WHAT THE AUTO-QUALITY NOTICE SAYS. PURE and import-free (vitest drives it).
//
// Every automatic quality toggle — the governor's ladder (shadows, resolution, AO, the scene
// look, particles) and what derives from it (the water losing its refraction, a fluid tank
// dropping to drops) — follows ONE rule: when the device lowers it on its own, the person is
// told once ("Lowered water quality to keep it smooth · Keep full quality"). One toast per
// drop names every toggle that drop newly lowered; a toggle already announced this session is
// not announced again (the chip in the object list still shows the current state).
//
// A snapshot is the state the notice watches:
//   {dprScale, shadowsOff, aoOff, postOff, particlesCapped, water, fluid}
// where `water` / `fluid` are simplifiedNotice's flags (set only when QUALITY simplified them —
// never for a headset or the user's own "Low" water pick).

/** The toggles, in the order a toast names them (the most visible first). */
export const QUALITY_TOGGLES = [
	{ key: 'water', name: 'water quality' },
	{ key: 'fluid', name: 'fluid quality' },
	{ key: 'shadows', name: 'shadows' },
	{ key: 'resolution', name: 'resolution' },
	{ key: 'ao', name: 'ambient occlusion' },
	{ key: 'post', name: 'the scene look' },
	{ key: 'particles', name: 'particles' }
];

/** @typedef {{dprScale?: number, shadowsOff?: boolean, aoOff?: boolean, postOff?: boolean, particlesCapped?: boolean, water?: boolean, fluid?: boolean}} QualitySnapshot */

/** Is this toggle lowered in `s`? @param {string} key @param {QualitySnapshot | null | undefined} s */
export function isLowered(key, s) {
	if (!s) return false;
	switch (key) {
		case 'water':
			return !!s.water;
		case 'fluid':
			return !!s.fluid;
		case 'shadows':
			return !!s.shadowsOff;
		case 'resolution':
			return Number(s.dprScale ?? 1) < 1;
		case 'ao':
			return !!s.aoOff;
		case 'post':
			return !!s.postOff;
		case 'particles':
			return !!s.particlesCapped;
	}
	return false;
}

/**
 * The toggles lowered in `next` that were not in `prev` (a further resolution step counts only
 * the first time resolution drops below full). @param {QualitySnapshot | null | undefined} prev
 * @param {QualitySnapshot} next @returns {string[]}
 */
export function newlyLowered(prev, next) {
	return QUALITY_TOGGLES.filter((t) => isLowered(t.key, next) && !isLowered(t.key, prev)).map((t) => t.key);
}

/**
 * What to announce: `keys` minus everything announced before, in QUALITY_TOGGLES order.
 * @param {string[]} keys @param {Iterable<string>} announced @returns {string[]}
 */
export function toAnnounce(keys, announced) {
	const seen = new Set(announced);
	const want = new Set(keys);
	return QUALITY_TOGGLES.filter((t) => want.has(t.key) && !seen.has(t.key)).map((t) => t.key);
}

/** "Lowered water quality and shadows to keep it smooth" @param {string[]} keys */
export function noticeText(keys) {
	const names = QUALITY_TOGGLES.filter((t) => keys.includes(t.key)).map((t) => t.name);
	if (!names.length) return '';
	const list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
	return 'Lowered ' + list + ' to keep it smooth';
}

/** The action's label (one place, so the suite and the docs agree). */
export const KEEP_FULL_LABEL = 'Keep full quality';
