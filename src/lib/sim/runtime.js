// 36-sim: the ONE per-frame entry for the simulation visuals — jiggle, splashes, fluid
// tanks. Scene's useTask calls `tickSim` (a single line there, the merge-hot-spot rule).
// Everything here is LOCAL per peer; what is shared is the inputs (poses, node data,
// userData), never the results.
import { tickJiggle } from './jiggleRuntime.js';
import { tickSplashes } from './splashWatch.js';
import { ensureWaterRoot, beginWaterFrame } from './waterQuery.js';
import { tickFluid } from './fluidRuntime.js';
// 36 S5: a scene load puts its primitives on screen before the fluid sims start (a leaf store)
import { heavyWorkDeferred } from '../sceneLoader';

/**
 * @param {any} root the scene objects group
 * @param {any} camera the render camera
 * @param {any} renderer
 * @param {number} now ms
 */
export function tickSim(root, camera, renderer, now) {
	tickJiggle(root, now);
	ensureWaterRoot(root);
	beginWaterFrame();
	tickSplashes(root, now);
	if (!heavyWorkDeferred()) tickFluid(root, camera, renderer, now);
}
