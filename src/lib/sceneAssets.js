import { writable, get } from 'svelte/store';
import { flowGraphs, allNodes } from '../stores/flowStore';
import { objectsGroup } from '../stores/sceneStore';
import { itemByHash } from './explorer';

// Scene asset manifest (108, quiz: DERIVED): the Explorer's 'Scene' folder is
// a live VIEW computed from what the replicated scene references — sound-node
// hashes (audio/), script-node code (config/), material texture maps
// (textures/). Nothing here syncs on its own: the references already
// replicate, so the manifest is identical on every peer by construction and
// entries vanish the moment nothing references them (clean state for free).

/** @type {import('svelte/store').Writable<any[]>}
 * entries: {id, group: 'audio'|'config'|'textures', name, kind,
 *           hash?, itemId?, nodeId?, uuid?, dataUrl?, derived} */
export const sceneAssets = writable([]);

function compute() {
	/** @type {any[]} */
	const out = [];
	const seenAudio = new Set();
	for (const node of allNodes()) { // H1: sound/script nodes live in any graph
		if (node.type === 'sound' && node.data?.hash && !seenAudio.has(node.data.hash)) {
			seenAudio.add(node.data.hash);
			out.push({
				id: 'audio:' + node.data.hash,
				group: 'audio',
				name: node.data.file || 'sound',
				kind: 'audio',
				hash: node.data.hash,
				itemId: itemByHash(node.data.hash)?.id ?? null,
				derived: false
			});
		}
		if (node.type === 'script' && node.data?.code?.trim()) {
			out.push({
				id: 'config:script:' + node.id,
				group: 'config',
				name: (node.data.name || 'script-' + String(node.id).slice(0, 5)) + '.js',
				kind: 'text',
				nodeId: node.id,
				derived: true
			});
		}
	}
	get(objectsGroup)?.traverse?.((/** @type {any} */ object) => {
		// UV2: one entry per TEXTURED SLOT. A multi-material mesh (imported
		// .obj/.mtl, a merged mesh) used to be skipped entirely, so its textures
		// were missing from the manifest and from a .tpscene export. Slot 0 keeps
		// the old id so nothing that stored one has to change.
		if (!object.material) return;
		const materials = Array.isArray(object.material) ? object.material : [object.material];
		materials.forEach((/** @type {any} */ material, /** @type {number} */ slot) => {
			const dataUrl = material?.userData?.mapDataUrl;
			if (!dataUrl) return;
			out.push({
				id: 'tex:' + object.uuid + (slot ? ':' + slot : ''),
				group: 'textures',
				name:
					(object.name || object.type) +
					(materials.length > 1 ? '-' + (material.name || 'slot' + slot) : '') +
					'.texture',
				kind: 'image',
				uuid: object.uuid,
				...(slot ? { slot } : {}),
				dataUrl,
				derived: true
			});
		});
	});
	sceneAssets.set(out);
}

let started = false;
/** @type {any} */ let timer = null;
function schedule() {
	clearTimeout(timer);
	timer = setTimeout(compute, 400);
}

export function startSceneAssets() {
	if (started || typeof window === 'undefined') return;
	started = true;
	flowGraphs.subscribe(schedule); // H1: any graph document change
	objectsGroup.subscribe(schedule);
	// texture changes mutate materials without an objectsGroup identity change
	// in some paths — a slow safety tick keeps the view honest
	setInterval(schedule, 5000);
}

/** SDK surface (108.3): what the shared scene currently uses */
export function sceneAssetList() {
	return get(sceneAssets).map((entry) => ({
		group: entry.group,
		name: entry.name,
		kind: entry.kind,
		hash: entry.hash ?? null
	}));
}
