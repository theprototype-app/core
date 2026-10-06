import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../../stores/sceneStore';
import { peers } from '../../stores/appStore';
import { recordEntry } from '../history';
import { normalizeFluid } from './fluidCore.js';

// 36-sim U2b: the ONE write path for a tank's `userData.fluid` — the setPhysicsFor shape:
// merge, one `props` undo entry, the existing `objectParameters` message (parameter
// 'fluid'), a poke. The particles never travel; these settings do.

/**
 * @param {string} uuid @param {any} patch shallow; `emitter`/`drain` merge one level down
 * @returns {any | null} the new block
 */
export function setFluidFor(uuid, patch) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object?.userData?.fluid) return null;
	const before = JSON.parse(JSON.stringify(object.userData.fluid));
	const merged = { ...before, ...patch };
	if (patch.emitter) merged.emitter = { ...before.emitter, ...patch.emitter };
	if (patch.drain) merged.drain = { ...before.drain, ...patch.drain };
	if (patch.spill) merged.spill = { ...before.spill, ...patch.spill }; // 36-fb-water F16
	const next = normalizeFluid(merged);
	object.userData.fluid = next;
	recordEntry({ kind: 'props', uuid, before: { fluid: before }, after: { fluid: next } });
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'objectParameters', parameter: 'fluid', uuid, fluid: next });
	pokeScene();
	return next;
}
