// Roadmap 66 S4b — IMAGE CARDS: what `import_file` places in the scene, seen from every peer.
//
// A card is an ordinary replicated mesh (a plane with the image as its map) carrying
// `userData.imageCard = {hash, name, specHash?, specName?, facing?, filter, frame?}`. Two things need
// more than the mesh itself, and both live here, started lazily (App's dynamic import, and the
// importer itself) so nothing is added to anybody's boot graph:
//
//   · FACING — a card with `facing: 'camera'` (or 'camera-y', turning about Y only, a standing
//     sprite) faces EACH viewer's camera. It is done in `onBeforeRender`, which three calls right
//     before it derives the model-view matrix from `matrixWorld`: we overwrite matrixWorld for that
//     draw only (updateMatrixWorld rebuilds it from the authored pose every frame), so the authored
//     transform, the wire, saves and undo never see the turn — it is local per peer by construction,
//     and each VR eye gets its own. The shadow pass does not call it: a card casts its authored
//     silhouette. The hook is installed by an objectsGroup sweep (the shadowDefaults shape), so a card
//     that arrives from a peer, a save or an undo gets it too.
//   · SAVES — the sheet and its spec are Explorer files; listing them as Scene ▸ generated entries
//     (with their hashes) is what makes a saved .tpscene bundle both, like any texture.

import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';

/** @type {WeakSet<any>} meshes whose hook is installed */
const hooked = new WeakSet();

/** @type {any} */
let THREE = null;
/** @type {{pos: any, quat: any, scale: any, cam: any, camScale: any, axis: any} | null} */
let tmp = null;

/** the onBeforeRender a facing card runs @this {any} @param {any} _r @param {any} _s @param {any} camera */
function faceCamera(_r, _s, camera) {
	const facing = this.userData?.imageCard?.facing;
	if (!facing || !THREE || !tmp || !camera?.matrixWorld) return;
	this.matrixWorld.decompose(tmp.pos, tmp.quat, tmp.scale);
	if (facing === 'camera-y') {
		tmp.cam.setFromMatrixPosition(camera.matrixWorld);
		tmp.quat.setFromAxisAngle(tmp.axis, Math.atan2(tmp.cam.x - tmp.pos.x, tmp.cam.z - tmp.pos.z));
	} else camera.matrixWorld.decompose(tmp.cam, tmp.quat, tmp.camScale);
	this.matrixWorld.compose(tmp.pos, tmp.quat, tmp.scale);
}

/** install the hook on every card that lacks it @param {any} group */
function sweep(group) {
	if (!group || !THREE) return;
	group.traverse((/** @type {any} */ node) => {
		if (!node.isMesh || hooked.has(node) || !node.userData?.imageCard) return;
		hooked.add(node);
		node.onBeforeRender = faceCamera;
	});
}

/** the scene's cards' files as Scene ▸ generated entries (hash = bundled into a .tpscene) */
export function cardEntries() {
	/** @type {any[]} */
	const out = [];
	const seen = new Set();
	get(objectsGroup)?.traverse?.((/** @type {any} */ o) => {
		const card = o.userData?.imageCard;
		if (!card || typeof card.hash !== 'string') return;
		for (const [hash, name, kind] of [
			[card.hash, card.name, 'image'],
			[card.specHash, card.specName, 'text']
		]) {
			if (typeof hash !== 'string' || !hash || seen.has(hash)) continue;
			seen.add(hash);
			out.push({ id: 'gen:' + hash, group: 'generated', name: String(name || 'generated'), kind, hash, derived: false });
		}
	});
	return out;
}

let started = false;
/** start the sweep + the scene entry source. Idempotent. */
export async function startImageCards() {
	if (started || typeof window === 'undefined') return;
	started = true;
	THREE = await import('three');
	tmp = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(), cam: new THREE.Vector3(), camScale: new THREE.Vector3(), axis: new THREE.Vector3(0, 1, 0) };
	objectsGroup.subscribe((group) => sweep(group));
	sweep(get(objectsGroup));
	const scene = await import('../sceneAssets');
	scene.registerSceneEntrySource?.(cardEntries);
}

/** re-run the sweep now (the importer, right after it added a card) */
export function refreshImageCards() {
	sweep(get(objectsGroup));
}
