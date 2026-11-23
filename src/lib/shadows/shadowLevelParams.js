// 106 — the knobs a drawn shadow level turns, and the setting row's capped line: pure, and LAZY (shadowLevels.js
// and the Configure Scene row import it; the boot only needs shadowLevelCore.js).
// imports NOTHING from shadowLevelCore at runtime (types only): a lazy importer would split the core out of
// environment's boot chunk into its own (+370 B measured)

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
	far: Object.freeze({ radius: 2, cascades: true, reach: 300, cascadeMap: 2048 })
});

/** @param {ShadowLevel} level */
export function levelParams(level) {
	return LEVEL_PARAMS[level] ?? LEVEL_PARAMS.basic;
}

/**
 * The cascades' reach for a scene: Far's 300 m, but never past 2.5x the scene's radius (a small scene keeps
 * its near cascade sharp) and never under 40 m. WHY 300 and not the 200 the brief names: three's sun shader draws
 * NO shadow past the last cascade's end and fades the last 10 % of the second cascade out, so a reach of 200
 * left an object at 200 m view depth unshadowed (Basic's one fitted map still shadows it, blurred). At 300 the
 * practical split puts the near cascade at ~0-78 m and 200 m sits in the solid part of the far one. Past the
 * reach Far draws no rig-sun shadow: the row and the docs say so.
 * @param {number} sceneRadius @param {number} [reach]
 */
export function cascadeReach(sceneRadius, reach = LEVEL_PARAMS.far.reach) {
	const r = Number(sceneRadius);
	const fit = Number.isFinite(r) && r > 0 ? r * 2.5 : reach;
	return Math.max(40, Math.min(reach, fit));
}

/** The setting row's line when the device draws less than the scene asks.
 * @param {ShadowLevel} asked the scene's level (shadowLevelOf'd) @param {ShadowLevel} drawn what this device draws
 * @returns {string} */
export function cappedNote(asked, drawn) {
	if (drawn === asked) return '';
	return 'This device draws ' + drawn[0].toUpperCase() + drawn.slice(1);
}

/**
 * The Cinematic view (WebGPU) picks a light's shadow node by the light's CLASS, so the WebGL cascade path (an
 * `isSunLight` flag on the rig sun) cannot reach it: while the view is on, Far is drawn as Soft there (its own
 * best: the fitted sun shadow with the wide kernel). Everything else is drawn as asked.
 * @param {ShadowLevel} drawn @param {boolean} cinematic
 * @returns {ShadowLevel}
 */
export function cinematicShadowLevel(drawn, cinematic) {
	return cinematic && drawn === 'far' ? 'soft' : drawn;
}


