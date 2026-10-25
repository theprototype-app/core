import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../../stores/sceneStore';
import { peers } from '../../stores/appStore';
import { recordEntry } from '../history';
import { setObjectsTexture } from '../materialsHandler';
import { compactSprite, compactLayer2d, normalizeSprite } from './spriteCore.js';

// 64-2d (D4 wave 1): THE WRITE SIDE of sprites and 2D layers — the setFluidFor shape: merge,
// one `props` undo entry, the existing `objectParameters` message (parameter 'sprite' /
// 'layer2d'), a poke. The documents are STORED COMPACT (compactSprite / compactLayer2d), so a
// plain sprite is a tiny block and a field added later never rewrites an old scene. The image
// rides the material map (setSpriteImage), so a clip edit never re-sends the pixels.

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid);
}

/** @param {string} uuid @param {string} key @param {any} before @param {any} next */
function commit(uuid, key, before, next) {
	const object = objectOf(uuid);
	if (!object) return;
	if (next) object.userData[key] = next;
	else delete object.userData[key];
	if (JSON.stringify(before ?? null) === JSON.stringify(next ?? null)) return;
	recordEntry({ kind: 'props', uuid, before: { [key]: before ?? null }, after: { [key]: next ?? null } });
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'objectParameters', parameter: key, uuid, [key]: next ?? null });
	pokeScene();
}

/**
 * Patch (or with `replace`, set) an object's sprite document; null removes it. `sheet` merges
 * one level down; `clips` is REPLACED whole when given (a clip list is one value).
 * @param {string} uuid @param {any} patch @param {{replace?: boolean}} [opts]
 * @returns {Record<string, any> | null} the stored block
 */
export function setSpriteFor(uuid, patch, opts = {}) {
	const object = objectOf(uuid);
	if (!object?.isMesh) return null;
	const before = object.userData.sprite ? JSON.parse(JSON.stringify(object.userData.sprite)) : null;
	if (patch === null) {
		commit(uuid, 'sprite', before, null);
		return null;
	}
	/** @type {any} */
	const base = opts.replace ? {} : normalizeSprite(before ?? {});
	/** @type {any} */
	const merged = { ...base, ...patch };
	if (patch.sheet && !opts.replace) merged.sheet = { ...base.sheet, ...patch.sheet };
	const next = compactSprite(merged);
	commit(uuid, 'sprite', before, next);
	return next;
}

/**
 * Make a group a 2D layer (parallax factors), or plain again with null.
 * @param {string} uuid @param {{parallax?: number, parallaxY?: number} | null} layer
 */
export function setLayer2dFor(uuid, layer) {
	const object = objectOf(uuid);
	if (!object) return null;
	const before = object.userData.layer2d ? { ...object.userData.layer2d } : null;
	const next = layer ? compactLayer2d({ ...(before ?? {}), ...layer }) : null;
	commit(uuid, 'layer2d', before, next);
	return next;
}

/**
 * The sprite's IMAGE: lossless PNG (setObjectsTexture goes lossless for a sprite target) through
 * the replicated `map` path — undo, saves and joiners are the material's own.
 * @param {string[]} uuids @param {File | Blob} file @param {{source?: string | null}} [opts]
 */
export function setSpriteImage(uuids, file, opts = {}) {
	return setObjectsTexture(uuids, file, 0, { ...opts, lossless: true });
}
