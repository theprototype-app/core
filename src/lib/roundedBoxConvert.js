// 102b-papercuts: CONVERT a baked rounded box into a Box with a corner radius, and its undo. A lazy chunk: the
// Inspector's button and an undo (or a peer's `baked` geometry message) load it; nothing on boot needs it.
import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { recordEntry, registerHistoryKind } from './history';
import { buildGeometry, cleanFor, defaultGeometryParams } from './geometryEdit';
import { roundedBoxOffer } from './roundedBoxGate.js';
import { bakedRoundedBox } from './roundedBox.js';

/**
 * Turn a baked rounded box into a Box with a corner radius: same vertices, now two numbers in the file.
 * One undo step (undo puts the baked mesh back), replicated as the ordinary `geometry` message.
 * @param {string} uuid @param {{replicate?: boolean, record?: boolean}} [options] @returns {boolean}
 */
export function convertToRoundedBox(uuid, options = {}) {
	const { replicate = true, record = true } = options;
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	const params = roundedBoxOffer(object);
	if (!params) return false;
	const full = cleanFor('Box', { ...defaultGeometryParams('Box'), ...params });
	const fresh = buildGeometry('Box', full);
	if (!fresh) return false;
	const g = /** @type {any} */ (object).geometry;
	// what the mesh carried that a rebuild would not (material groups are refused above; keep its userData)
	fresh.userData = { ...(g.userData ?? {}) };
	g.dispose();
	/** @type {any} */ (object).geometry = fresh;
	/** @type {any} */ (object).userData.geometryParams = { gtype: 'Box', params: full };
	pokeScene();
	if (record) recordEntry({ kind: 'roundconvert', uuid, params: full, before: { baked: true }, after: { baked: false } });
	if (replicate) /** @type {any} */ (get(peers))?.send({ type: 'geometry', uuid, gtype: 'Box', params: full });
	return true;
}

/** back to the baked mesh (undo of a Convert, here or from a peer) @param {any} object @param {any} params */
export function unconvertLocal(object, params) {
	const baked = bakedRoundedBox(cleanFor('Box', { ...params }));
	if (!baked) return;
	object.geometry.dispose();
	object.geometry = baked;
	delete object.userData.geometryParams;
	pokeScene();
}

registerHistoryKind('roundconvert', (entry, state) => {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', entry.uuid);
	if (!object) return false;
	if (!state?.baked) {
		const params = entry.params;
		const fresh = buildGeometry('Box', params);
		if (!fresh) return false;
		/** @type {any} */ (object).geometry.dispose();
		/** @type {any} */ (object).geometry = fresh;
		/** @type {any} */ (object).userData.geometryParams = { gtype: 'Box', params };
		pokeScene();
		/** @type {any} */ (get(peers))?.send({ type: 'geometry', uuid: entry.uuid, gtype: 'Box', params });
		return true;
	}
	unconvertLocal(object, entry.params);
	/** @type {any} */ (get(peers))?.send({ type: 'geometry', uuid: entry.uuid, gtype: 'Box', params: entry.params, baked: true });
	return true;
});

