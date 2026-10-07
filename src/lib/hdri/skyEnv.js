// 37-hdri — the LEAF stores other renderers read the live HDRI through (no imports beyond
// svelte/store, so the water runtime and Outline.svelte reach it without pulling in the loader,
// the Explorer or the environment's import family).
import { writable } from 'svelte/store';

/**
 * The HDRI the scene is lit by right now, or null (none, still loading, passthrough).
 * `texture` is the PMREM (CubeUV) texture — the same one scene.environment holds — so a custom
 * shader samples it with three's `textureCubeUV`; `rotationY` is in radians (the sky's turn),
 * `intensity` the IBL strength. LOCAL render state, never sent or saved.
 * @type {import('svelte/store').Writable<{texture: any, rotationY: number, intensity: number, size: number} | null>}
 */
export const skyEnv = writable(null);

/**
 * The tone mapping the ENVIRONMENT asks the desktop composer for while an HDRI shows
 * ({mode: 'aces'|'agx'|'neutral'}), or null. The composer renders into a target, where the
 * renderer's own tone mapping never applies (CLAUDE.md "renderer.toneMapping NEVER REACHES A
 * COMPOSED FRAME"), so without a pass an HDRI sky would clip at 1.0 on the desktop.
 * @type {import('svelte/store').Writable<{mode: string} | null>}
 */
export const envToneMapping = writable(null);

/**
 * For the UI and the suite: what the HDRI layer is doing.
 * @type {import('svelte/store').Writable<{state: 'off'|'loading'|'ready'|'missing'|'error', src: string, tier: string, width: number, pmremSize: number, error: string, ms: number}>}
 */
export const hdriStatus = writable({ state: 'off', src: '', tier: '', width: 0, pmremSize: 0, error: '', ms: 0 });
