// 69 — START THE GUEST ENGINE WITH THE SCENE THAT NEEDS IT. The engine (engine.js) loads lazily on the
// first script call, which put its whole download + compile AFTER the scene had finished building:
// the first script ran ~2.5 s after a game opened. A scene that carries code starts the load the moment
// it starts to arrive, so the engine loads while the objects build. A scene with no code loads nothing
// (no idle preload for every scene). A LEAF beside engine.js: it only reads the payload.

import { sandboxNow, sandboxReady } from './engine.js';
import { builtinCodeActive } from '../builtinCode.js';

const CODE_NODES = new Set(['script', 'behaviour', 'customnode']);

/** @param {any} nodes */
function nodesCarryCode(nodes) {
	return (
		Array.isArray(nodes) &&
		nodes.some((node) => CODE_NODES.has(node?.type) || builtinCodeActive(node))
	);
}

/** a HUD "Custom (code)" element anywhere in a HUD documents map (screens → elements, bounded walk)
 * @param {any} value @param {number} depth */
function hudCarriesCode(value, depth = 0) {
	if (!value || typeof value !== 'object' || depth > 6) return false;
	if (value.kind === 'custom' && typeof value.code === 'string' && value.code.trim()) return true;
	for (const child of Array.isArray(value) ? value : Object.values(value))
		if (hudCarriesCode(child, depth + 1)) return true;
	return false;
}

/** Does a scene payload (a session / .tpscene, or a peer's nodes / huds snapshot) carry code the guest runs?
 * @param {any} payload a session payload, or a `nodes` / `huds` message */
export function payloadCarriesCode(payload) {
	if (!payload || typeof payload !== 'object') return false;
	if (nodesCarryCode(payload.nodes)) return true;
	if (payload.graphs && typeof payload.graphs === 'object')
		for (const graph of Object.values(payload.graphs))
			if (nodesCarryCode(graph?.nodes)) return true;
	return hudCarriesCode(payload.hud) || hudCarriesCode(payload.huds);
}

/** Start loading the engine now if this payload will need it. Never throws, never waits.
 * @param {any} payload @returns {boolean} whether a load was started (or the engine is already there) */
export function preloadSandboxFor(payload) {
	if (sandboxReady()) return true;
	try {
		if (!payloadCarriesCode(payload)) return false;
		sandboxNow();
		return true;
	} catch {
		return false;
	}
}
