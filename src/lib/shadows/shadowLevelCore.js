// 106 S1 — SHADOW QUALITY AS A SCENE SETTING, the pure BOOT half (imports NOTHING): only what environment.js
// needs to decide whether a scene asks for more than Basic. The knobs a level turns live in shadowLevelParams.js,
// which only the lazy Soft / Far chunk and the setting row load (every byte here is paid by every boot).
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
 * THE TIER TABLE (S0 measured it, STATUS-106-shadows + the lane's s0/ evidence): the highest level each tier draws.
 * A scene that asks for more is drawn at the cap, and the setting says "This device draws <cap>". Off is never
 * capped up: a scene that asks for no shadows has none anywhere.
 *  · phone  Soft (HONOR Adreno 750, dpr 3: Soft's wide kernel cost the same frames as Basic on four scenes; Far's
 *           second cascade pass and the contact pass both added frames over 20 ms, so neither is given)
 *  · quest  Basic until the headset is measured on a preview (Basic = today's code path, so no frame can be lost)
 */
export const TIER_SHADOW_CAP = Object.freeze({ pc: 'far', phone: 'soft', quest: 'basic' });

/**
 * What THIS device draws for a scene's ask.
 * @param {any} asked the scene's stored level @param {ShadowTier} tier @returns {ShadowLevel}
 */
export function drawnShadowLevel(asked, tier) {
	const want = shadowLevelOf(asked);
	const cap = /** @type {ShadowLevel} */ (TIER_SHADOW_CAP[tier] ?? 'basic');
	return RANK[want] <= RANK[cap] ? want : cap;
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
