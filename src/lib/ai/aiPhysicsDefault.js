// fix-live (roadmap 55 "Fixes for 54" F-4, test flight T8): what the AI tools' create does
// about physics. The Add menu stamps standard primitives DYNAMIC, mass 1 (geometries.svelte.js,
// "fun by default": a cube you drop falls). Right for one cube a person places; wrong for a
// scene an AI builds out of 40 of them — every wall, rock and roof beam fell over the moment
// Play started a sim. AI-made objects are STATIC unless the request asks for physics
// (`physics: 'dynamic'` or a `mass`). Pure: the caller writes the patch through setPhysicsFor.

/**
 * @param {any} spec one create_objects entry
 * @param {any} stamped the `userData.physics` the builder stamped (or undefined)
 * @returns {{mode: 'static'} | {mode: 'dynamic', mass: number} | null} the patch, or null for none
 */
export function aiCreatePhysics(spec, stamped) {
	const mass = Number(spec?.mass);
	const wantsMass = spec?.mass != null && Number.isFinite(mass) && mass > 0;
	if (spec?.physics === 'dynamic' || wantsMass) {
		const m = wantsMass ? Math.min(mass, 10000) : 1;
		if (stamped?.mode === 'dynamic' && (stamped.mass ?? 1) === m) return null;
		return { mode: 'dynamic', mass: m };
	}
	// nothing asked: only an object the builder made dynamic needs turning back
	if (stamped?.mode === 'dynamic') return { mode: 'static' };
	return null;
}
