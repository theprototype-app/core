// mcp-shapes — castShadow / receiveShadow from an agent: the Inspector's flag path (objectParameters on the wire,
// a `flags` undo entry each), on a mesh, or on every mesh inside a group or a model (a group draws nothing itself).
import { setObjectFlag } from '$lib/multiEdit';
import { markShadowsChosen } from '$lib/shadowDefaults';

export const SHADOW_KEYS = /** @type {const} */ (['castShadow', 'receiveShadow']);

/** does this spec name a mesh shadow flag? @param {any} spec */
export const hasShadowFlags = (spec) => SHADOW_KEYS.some((k) => spec?.[k] !== undefined);

/**
 * @param {any} object @param {any} spec @param {{keys?: readonly string[]}} [opts] which keys (a light takes castShadow its own way)
 * @returns {string[]} errors
 */
export function applyShadowFlags(object, spec, opts = {}) {
	/** @type {string[]} */
	const errors = [];
	const keys = (opts.keys ?? SHADOW_KEYS).filter((k) => spec?.[k] !== undefined);
	if (!keys.length) return errors;
	/** @type {any[]} */
	const meshes = [];
	if (object?.isMesh) meshes.push(object);
	else object?.traverse?.((/** @type {any} */ n) => n.isMesh && meshes.push(n));
	for (const key of keys) {
		const value = spec[key];
		if (typeof value !== 'boolean') errors.push(key + ': true or false');
		else if (!meshes.length) errors.push(key + ': nothing in this ' + String(object?.type ?? 'object') + ' draws a shadow');
		else
			for (const mesh of meshes) {
				markShadowsChosen(mesh);
				// written and sent even when it already reads so here: a fresh mesh reads false before the defaults
				// sweep, and only the written flag (castShadow's userData.shadow) keeps peers and saves from defaulting it
				const had = mesh[key];
				mesh[key] = !value;
				setObjectFlag(mesh, key, value, { before: had });
			}
	}
	return errors;
}

/** the schema rows, shared by create_objects / update_objects / the shape tools */
export const SHADOW_SCHEMA = {
	castShadow: { type: 'boolean', description: 'meshes and models: cast a shadow (on by default); lights: directional / spot / point cast shadows' },
	receiveShadow: { type: 'boolean', description: 'meshes and models: shadows fall on it (on by default)' }
};
