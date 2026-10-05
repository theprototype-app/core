// 36-sim: the ONE per-frame entry for the simulation visuals — jiggle, splashes, fluid
// tanks. Scene's useTask calls `tickSim` (a single line there, the merge-hot-spot rule).
// Everything here is LOCAL per peer; what is shared is the inputs (poses, node data,
// userData), never the results.
import { tickJiggle } from './jiggleRuntime.js';
import { tickSplashes } from './splashWatch.js';
import { ensureWaterRoot, beginWaterFrame } from './waterQuery.js';
import { tickFluid, simHeld } from './fluidRuntime.js';
import { tickPours } from '../water/pourDrops.js';

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
	tickFluid(root, camera, renderer, now);
	tickPours(root, camera, renderer, now, simHeld()); // 36-fb-water F16/F17 (+ S9 pause): pour emitters + tank spills
}
