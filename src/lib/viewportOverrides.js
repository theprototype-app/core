import { writable, get } from 'svelte/store';

// B — VIEWPORT OVERRIDES (this device).
//
// ONE concept for "the scene says X, but not on my screen". It exists because the
// alternative does not scale: local overrides were being invented per feature —
// wireframe inside the view modes, the UV checker inside the UV editor, a
// `postEnabledLocal` checkbox for the post stack — and layers 2 and 3 (the scene
// default material, per-object shaders) would each have earned another one, plus
// another round of "do my peers have to switch something on?".
//
// THE RULE THIS ENCODES: every authored layer is SCENE DATA and renders for
// everyone by default. What is local is the right to switch it off HERE, for
// performance, comfort or diagnosis. Nobody opts in to seeing the scene.
//
// A leaf: stores only, so anything may import it.

const KEY = 'viewportOverrides';
// the pre-B home of the post flag, migrated once so an existing user's choice
// survives (it was a plain 'true'/'false' string)
const LEGACY_POST_KEY = 'postEnabledLocal';

/**
 * @typedef {{key: string, label: string, hint: string}} OverrideDef
 */

/**
 * The layers a viewer may switch off locally. `shaders` is declared HERE, ahead of
 * L6/L7 needing it, precisely so those phases add a renderer and not a new concept.
 * @type {OverrideDef[]}
 */
export const OVERRIDES = [
	{
		key: 'post',
		label: 'Scene look (post-processing)',
		hint: 'Grading, ambient occlusion and camera effects the scene author set up. Turning this off is local — it changes nothing for anyone else.'
	},
	{
		key: 'shaders',
		label: 'Scene shaders',
		hint: 'Materials driven by the scene’s shader graphs. Reserved for the shader work; nothing reads it yet.'
	}
];

function load() {
	/** @type {Record<string, boolean>} */
	const state = {};
	for (const def of OVERRIDES) state[def.key] = true;
	if (typeof localStorage === 'undefined') return state;
	try {
		const raw = localStorage.getItem(KEY);
		if (raw) Object.assign(state, JSON.parse(raw));
		else if (localStorage.getItem(LEGACY_POST_KEY) === 'false') state.post = false;
	} catch {}
	return state;
}

/** @type {import('svelte/store').Writable<Record<string, boolean>>} */
export const viewportOverrides = writable(load());
viewportOverrides.subscribe((state) => {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(KEY, JSON.stringify(state));
	} catch {}
});

/** Is this layer rendered on THIS device? Unknown keys default to ON, so a layer
 * that has not been switched off is never accidentally hidden. @param {string} key */
export function renderLayer(key) {
	return get(viewportOverrides)[key] !== false;
}

/** @param {string} key @param {boolean} on */
export function setRenderLayer(key, on) {
	viewportOverrides.update((state) => ({ ...state, [key]: !!on }));
}

/** test/debug view */
export function viewportOverridesDebug() {
	return { ...get(viewportOverrides) };
}
