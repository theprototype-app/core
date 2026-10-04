// 36 A5 — WHERE THE FOG ENDS, AND WHO SAID SO. A LEAF (imports nothing), so the rule is
// provable with no scene and no renderer.
//
// The environment grows a PRESET's fog with the scene ("fog never swallows a big scene":
// far = max(far, 2.5 x the scene radius)), and that is right for a preset nobody tuned. It was
// ALSO applied to a fog the user had set by hand, so Configure Scene > Fog > Far reverted to
// the scene's reach on every applyEnvironment() — the slider moved and the fog did not.
// A fog edited through the Inspector (or any editEnvSky patch naming near/far) is AUTHORED:
// it carries `fit: false` and keeps exactly the reach it was given. Absent = a preset's,
// which still grows — so every saved scene and every older peer's document is unchanged.

/** the multiple of the scene radius a preset's fog reaches at least */
export const FOG_REACH_FACTOR = 2.5;

/**
 * The far distance to draw a fog with.
 * @param {{far: number, fit?: boolean}} fog @param {number} radius the scene's bounding radius
 */
export function fogFarFor(fog, radius) {
	const far = Number(fog?.far);
	if (!Number.isFinite(far)) return 0;
	if (fog?.fit === false) return far;
	return Math.max(far, (Number(radius) || 0) * FOG_REACH_FACTOR);
}

/**
 * A fog patch merged onto the current fog. Naming `near` or `far` makes the fog AUTHORED
 * (`fit: false`); a colour-only patch keeps whatever the fog was. `null` removes the fog; a patch
 * on no fog starts from `base`.
 * @param {any} current @param {any} patch @param {{color: string, near: number, far: number}} [base]
 */
export function mergeFogPatch(current, patch, base = { color: '#ffffff', near: 1, far: 50 }) {
	if (patch === null) return null;
	const next = { ...(current ?? base), ...patch };
	if (patch && (patch.near !== undefined || patch.far !== undefined)) next.fit = false;
	return next;
}
