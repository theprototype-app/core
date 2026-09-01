// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { ensureAudioContext, bus } from './audioEngine';
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

/** Build the gain -> HRTF panner chain once per entry. @param {any} entry @param {any} data */
function ensureChain(entry, data) {
	const ctx = context();
	if (!ctx) return null;
	if (!entry.gain) {
		entry.gain = ctx.createGain();
		entry.panner = ctx.createPanner();
		entry.panner.panningModel = 'HRTF';
		entry.panner.distanceModel = 'inverse';
		entry.gain.connect(entry.panner).connect(bus('sfx'));
	}
	entry.gain.gain.value = data.volume ?? 0.8;
	entry.panner.refDistance = data.radius ?? 5;
	entry.panner.rolloffFactor = data.rolloff ?? 1; // how fast it fades with distance
	return ctx;
}

/**
 * 21-E4: play the buffer ONCE, on a flow event.
 *
 * A separate, fire-and-forget source rather than `entry.src`: that slot belongs to
 * the `playing` state and its key comparison, so borrowing it would make a
 * one-shot look like a stopped loop (and stop a loop that was running). Nothing
 * about this replicates - the trigger STAMP already did, so every peer reaches
 * this line itself, which is the same reasoning as the looped phase below.
 * @param {any} entry @param {any} data
 */
function playOnce(entry, data) {
	const ctx = ensureChain(entry, data);
	if (!ctx || !entry.buffer) return;
	const src = ctx.createBufferSource();
	src.buffer = entry.buffer;
	src.loop = false;
	src.connect(entry.gain);
	src.start(0);
	entry.fired = (entry.fired ?? 0) + 1;
}

/** @param {any} entry @param {any} data @param {number} time */
function startSource(entry, data, time) {
	stopSource(entry);
	const ctx = ensureChain(entry, data);
	if (!ctx) return;
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
 * @param {{node: any, uuid: string, trigger?: number|null}[]} pairs @param {any} sceneObjects @param {number} time
 */
export function updateSounds(pairs, sceneObjects, time) {
	const wanted = new Set();
	for (const { node, uuid, trigger } of pairs) {
		const data = node.data ?? {};
		if (!data.hash) continue;
		wanted.add(node.id);
		let entry = entries.get(node.id);
		if (!entry || entry.hash !== data.hash) {
			dropEntry(entry);
			// 21-E4: `firedAt` starts at whatever stamp is ALREADY standing, not null - a
			// chain built while an old pulse is on the wire must not replay history the
			// moment it decodes.
			entry = {
				hash: data.hash,
				buffer: null,
				src: null,
				gain: null,
				panner: null,
				key: '',
				firedAt: typeof trigger === 'number' ? trigger : null,
				fired: 0
			};
			entries.set(node.id, entry);
		}
		if (!entry.buffer) {
			if (!entry.failed) loadBuffer(entry, data.hash);
			continue;
		}
		// 21-E4: one shot per NEW stamp. Stamp-edge, never per frame: a pulse is high
		// for ~0.3s, which at 60fps is eighteen copies of the same sound.
		if (typeof trigger === 'number' && entry.firedAt !== trigger) {
			entry.firedAt = trigger;
			playOnce(entry, data);
		}
		// #22 A1 finding 4: volume/radius/rolloff are NOT in the key. They were, and a
		// key change tears the source down and restarts it — so every fader drag clicked
		// and every one-shot restarted from zero. They are live params; set them below.
		const key = [!!data.playing, data.loop !== false].join('|');
		if (data.playing && (!entry.src || entry.key !== key)) startSource(entry, data, time);
		else if (!data.playing && entry.src) stopSource(entry);
		// live, without a restart — the sceneMusic.reconcile precedent
		if (entry.gain) entry.gain.gain.value = data.volume ?? 0.8;
		if (entry.panner) {
			entry.panner.refDistance = data.radius ?? 5;
			entry.panner.rolloffFactor = data.rolloff ?? 1;
		}
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
		// 21-E4: how many one-shots the trigger input has fired, and the stamp it last
		// acted on - the only way a suite can see a fire-and-forget source at all
		fired: entry.fired ?? 0,
		firedAt: entry.firedAt ?? null,
		panner: entry.panner ? [entry.panner.positionX?.value ?? 0, entry.panner.positionY?.value ?? 0, entry.panner.positionZ?.value ?? 0] : null
	}));
}
