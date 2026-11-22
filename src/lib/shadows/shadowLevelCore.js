// 106 S1 — SHADOW QUALITY AS A SCENE SETTING, the pure half (imports NOTHING).
//
// Configure Scene ▸ Lights ▸ Shadow quality: Off · Basic · Soft · Far. The level is SCENE data (it rides the
// environment state like lodBias: saved, sent, latest change wins) and every device DRAWS it capped by its tier,
// the 98 Pro look pattern: the scene stores one ask, a phone or a headset draws less, nobody's device rewrites
// the scene for the others.
//   · off   — no shadows in this scene (the renderer's shadow map off, the catcher hidden)
//   · basic — exactly today's look and cost: one shadow map per casting light, PCF, the fitted rig frustum.
//             ABSENT = basic, so every scene saved before 106 (and an older release reading a new one) is Basic.
//   · soft  — Basic's maps with a wider PCF kernel (same five taps, so the same cost) + contact shadows (S2)
//             on tiers that can pay for them
//   · far   — the scene's sun draws two CASCADES (three r186 SunLightShadow: sharp near, present far, one
//             atlas, the renderer's own sun-light path) + Soft's kernel + contact shadows where they fit

export const SHADOW_LEVELS = Object.freeze(['off', 'basic', 'soft', 'far']);

/** @typedef {'off'|'basic'|'soft'|'far'} ShadowLevel */
/** @typedef {'pc'|'phone'|'quest'} ShadowTier */

/** The level a stored value means: anything unknown or absent is Basic (an old scene, an old peer).
 * @param {any} v @returns {ShadowLevel} */
export function shadowLevelOf(v) {
	return SHADOW_LEVELS.includes(v) ? /** @type {ShadowLevel} */ (v) : 'basic';
}

/** The tier from the 98 finish facts (headset or presenting = quest, coarse pointer = phone, else pc).
 * @param {{presenting?: boolean, headset?: boolean, phone?: boolean}} facts @returns {ShadowTier} */
export function shadowTierOf(facts) {
	if (facts?.presenting || facts?.headset) return 'quest';
	if (facts?.phone) return 'phone';
	return 'pc';
}

const RANK = { off: 0, basic: 1, soft: 2, far: 3 };

/**
 * THE TIER TABLE (S0 decides it; ~/.code/lanes-30/after-106/106-shadows/s0/): the highest level each tier draws.
 * A scene that asks for more is drawn at the cap, and the setting says "This device draws <cap>". Off is never
 * capped up: a scene that asks for no shadows has none anywhere.
 */
export const TIER_SHADOW_CAP = Object.freeze({ pc: 'far', phone: 'basic', quest: 'basic' });

/** Contact shadows (S2) per tier: only where S0 measured they fit. */
export const TIER_CONTACT = Object.freeze({ pc: true, phone: false, quest: false });

/**
 * What THIS device draws for a scene's ask.
 * @param {any} asked the scene's stored level @param {ShadowTier} tier @returns {ShadowLevel}
 */
export function drawnShadowLevel(asked, tier) {
	const want = shadowLevelOf(asked);
	const cap = /** @type {ShadowLevel} */ (TIER_SHADOW_CAP[tier] ?? 'basic');
	return RANK[want] <= RANK[cap] ? want : cap;
}

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
