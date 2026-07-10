// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { ensureAudioContext } from './voiceChat';
import { itemByHash, itemBlob } from './explorer';
import { requestAsset } from './assetShare';

// Sound node runtime (97): flowRuntime hands over (sound node, target uuid)
// pairs each tick. Every playing pair keeps an AudioBufferSource ->
// gain -> HRTF panner chain; the panner tracks the object's world position.
// Determinism: looped playback derives its phase from the synced clock
// (time % duration), so peers hear the same moment without streaming.

/** @type {Map<string, any>} nodeId -> entry */
const entries = new Map();
const tempPos = new THREE.Vector3();

function context() {
	try {
		const ctx = ensureAudioContext();
		if (ctx.state === 'suspended') ctx.resume().catch(() => {});
		return ctx;
	} catch {
		return null;
	}
}

/** @param {any} entry */
function stopSource(entry) {
	try {
		entry.src?.stop();
	} catch {}
	entry.src?.disconnect();
	entry.src = null;
}

/** @param {any} entry */
function dropEntry(entry) {
	if (!entry) return;
	stopSource(entry);
	entry.panner?.disconnect();
	entry.gain?.disconnect();
}

/** @param {any} entry @param {string} hash */
async function loadBuffer(entry, hash) {
	const item = itemByHash(hash);
	if (!item) {
		requestAsset(hash); // pull once; the entry retries next tick
		return;
	}
	if (entry.decoding) return;
	entry.decoding = true;
	try {
		const blob = await itemBlob(item.id);
		const ctx = context();
		if (blob && ctx) entry.buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
	} catch (error) {
		console.log('sound decode failed', error);
		entry.failed = true;
	}
	entry.decoding = false;
}

/** @param {any} entry @param {any} data @param {number} time */
function startSource(entry, data, time) {
	const ctx = context();
	if (!ctx) return;
	stopSource(entry);
	if (!entry.gain) {
		entry.gain = ctx.createGain();
		entry.panner = ctx.createPanner();
		entry.panner.panningModel = 'HRTF';
		entry.panner.distanceModel = 'inverse';
		entry.gain.connect(entry.panner).connect(ctx.destination);
	}
	entry.gain.gain.value = data.volume ?? 0.8;
	entry.panner.refDistance = data.radius ?? 5;
	const src = ctx.createBufferSource();
	src.buffer = entry.buffer;
	src.loop = data.loop !== false;
	src.connect(entry.gain);
	// synced phase: everyone starts inside the same loop cycle
	const offset = src.loop ? time % entry.buffer.duration : 0;
	src.start(0, offset);
	src.onended = () => {
		if (entry.src === src) entry.src = null;
	};
	entry.src = src;
}

/**
 * Called by flowRuntime each tick with the live sound edges.
 * @param {{node: any, uuid: string}[]} pairs @param {any} sceneObjects @param {number} time
 */
export function updateSounds(pairs, sceneObjects, time) {
	const wanted = new Set();
	for (const { node, uuid } of pairs) {
		const data = node.data ?? {};
		if (!data.hash) continue;
		wanted.add(node.id);
		let entry = entries.get(node.id);
		if (!entry || entry.hash !== data.hash) {
			dropEntry(entry);
			entry = { hash: data.hash, buffer: null, src: null, gain: null, panner: null, key: '' };
			entries.set(node.id, entry);
		}
		if (!entry.buffer) {
			if (!entry.failed) loadBuffer(entry, data.hash);
			continue;
		}
		const key = [!!data.playing, data.loop !== false, data.volume ?? 0.8, data.radius ?? 5].join('|');
		if (data.playing && (!entry.src || entry.key !== key)) startSource(entry, data, time);
		else if (!data.playing && entry.src) stopSource(entry);
		entry.key = key;
		const object = sceneObjects?.getObjectByProperty('uuid', uuid);
		if (object && entry.panner) {
			object.getWorldPosition(tempPos);
			if (entry.panner.positionX) {
				entry.panner.positionX.value = tempPos.x;
				entry.panner.positionY.value = tempPos.y;
				entry.panner.positionZ.value = tempPos.z;
			} else entry.panner.setPosition(tempPos.x, tempPos.y, tempPos.z);
		}
	}
	for (const [id, entry] of entries)
		if (!wanted.has(id)) {
			dropEntry(entry);
			entries.delete(id);
		}
}

/** test/debug view of the live chains */
export function soundEntries() {
	return [...entries.entries()].map(([id, entry]) => ({
		id,
		hash: entry.hash,
		buffered: !!entry.buffer,
		playing: !!entry.src,
		panner: entry.panner ? [entry.panner.positionX?.value ?? 0, entry.panner.positionY?.value ?? 0, entry.panner.positionZ?.value ?? 0] : null
	}));
}
