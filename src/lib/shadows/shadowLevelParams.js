// 106 — the knobs a drawn shadow level turns, and the setting row's capped line: pure, and LAZY (shadowLevels.js
// and the Configure Scene row import it; the boot only needs shadowLevelCore.js).
import { shadowLevelOf, drawnShadowLevel } from './shadowLevelCore.js';

/** @typedef {import('./shadowLevelCore.js').ShadowLevel} ShadowLevel */
/** @typedef {import('./shadowLevelCore.js').ShadowTier} ShadowTier */

/** Contact shadows (S2) per tier: only where S0 measured they fit. */
export const TIER_CONTACT = Object.freeze({ pc: true, phone: false, quest: false });

/** Does this device draw contact shadows for the drawn level? @param {ShadowLevel} drawn @param {ShadowTier} tier */
export function contactShadowsOn(drawn, tier) {
	return (drawn === 'soft' || drawn === 'far') && !!TIER_CONTACT[tier];
}

/**
 * The knobs a drawn level turns. Basic is the identity (nothing written), so Basic stays byte-for-byte today's.
 *  · radius       PCF kernel radius in texels (three's default 1)
 *  · cascades     the sun draws SunLightShadow's two cascades
 *  · reach        how far (m) the cascades reach from the camera (the sun shadow camera's far)
 *  · cascadeMap   per-cascade map size before the device's own size cap
 */
export const LEVEL_PARAMS = Object.freeze({
	off: Object.freeze({ radius: 1, cascades: false, reach: 0, cascadeMap: 0 }),
	basic: Object.freeze({ radius: 1, cascades: false, reach: 0, cascadeMap: 0 }),
	soft: Object.freeze({ radius: 3, cascades: false, reach: 0, cascadeMap: 0 }),
	far: Object.freeze({ radius: 2, cascades: true, reach: 200, cascadeMap: 2048 })
});

/** @param {ShadowLevel} level */
export function levelParams(level) {
	return LEVEL_PARAMS[level] ?? LEVEL_PARAMS.basic;
}

/**
 * The cascades' reach for a scene: Far's 200 m, but never past twice the scene's size (a small scene keeps
 * its near cascade sharp) and never under 40 m.
 * @param {number} sceneRadius @param {number} [reach]
 */
export function cascadeReach(sceneRadius, reach = LEVEL_PARAMS.far.reach) {
	const r = Number(sceneRadius);
	const fit = Number.isFinite(r) && r > 0 ? r * 2.5 : reach;
	return Math.max(40, Math.min(reach, fit));
}

/** The setting row's line when the device draws less than the scene asks.
 * @param {any} asked @param {ShadowTier} tier @returns {string} */
export function cappedNote(asked, tier) {
	const want = shadowLevelOf(asked);
	const drawn = drawnShadowLevel(want, tier);
	if (drawn === want) return '';
	return 'This device draws ' + drawn[0].toUpperCase() + drawn.slice(1);
}

