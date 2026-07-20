// @ts-ignore - no bundled three type declarations (project-wide)
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { writable, get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { itemByHash, itemBlob } from './explorer';
import { requestAsset, sendAsset } from './assetShare';

// Custom hand models (R-3): a user's chosen hand GLB is part of their IDENTITY
// (the avatar-photo precedent) — the content HASH rides a tiny `handmodel`
// message (+ the handshake), peers pull the bytes via the existing assetShare
// hash push/pull, and Player renders the model RIGIDLY at each broadcast wrist
// pose (the hand group's pos/rot IS the wrist, so no retargeting is needed for
// v1 — articulated joint retargeting stays in the backlog). Fallback chain:
// custom model -> the viewer's peerHandStyle (model capsules / cuboids /
// spheres) while bytes load or when parsing fails.

/** my chosen hand model hash ('' = none), LOCAL pref that broadcasts */
export const myHandModel = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('myHandModel') ?? '' : ''
);

/** @type {import('svelte/store').Writable<Record<string, string>>} peerId -> hash */
export const peerHandModels = writable({});

/** @type {import('svelte/store').Writable<Record<string, any>>} hash -> parsed THREE scene (null while loading/failed) */
export const handModelCache = writable({});

/** @type {Set<string>} hashes we've started loading */
const loading = new Set();

/** Pick my hand model (Explorer model item hash, '' clears), push + broadcast.
 * @param {string} hash */
export function setMyHandModel(hash) {
	myHandModel.set(hash ?? '');
	if (hash) sendAsset(hash); // push the bytes so peers can render immediately
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'handmodel', peerId: peer.peer.id, hash: hash ?? '' });
}

/** Handshake payload (our current choice). */
export function handModelState() {
	/** @type {any} */
	const peer = get(peers);
	return { type: 'handmodel', peerId: peer?.peer?.id, hash: get(myHandModel) };
}

/** Receive a peer's choice; start pulling/parsing the bytes. @param {any} data */
export function applyHandModel(data) {
	if (!data?.peerId) return;
	peerHandModels.update((map) => {
		const next = { ...map };
		if (data.hash) next[data.peerId] = data.hash;
		else delete next[data.peerId];
		return next;
	});
	if (data.hash) ensureHandModel(data.hash);
}

/** @param {string} peerId */
export function dropPeerHandModel(peerId) {
	peerHandModels.update((map) => {
		const next = { ...map };
		delete next[peerId];
		return next;
	});
}

/** Load + parse a hand GLB by content hash into the cache (idempotent).
 * Retries via the reconcile tick until the assetShare pull lands. @param {string} hash */
export async function ensureHandModel(hash) {
	if (!hash || loading.has(hash) || get(handModelCache)[hash]) return;
	const item = itemByHash(hash);
	if (!item) {
		requestAsset(hash); // pull once; retried by the interval below
		return;
	}
	loading.add(hash);
	try {
		const blob = await itemBlob(item.id);
		if (!blob) throw new Error('no bytes');
		const buffer = await blob.arrayBuffer();
		const gltf = await new Promise((resolve, reject) =>
			new GLTFLoader().parse(buffer, '', resolve, reject)
		);
		handModelCache.update((map) => ({ ...map, [hash]: /** @type {any} */ (gltf).scene }));
	} catch (error) {
		console.log('hand model parse failed', error);
		loading.delete(hash); // allow a retry if the bytes arrive later/again
	}
}

let started = false;
export function startHandModels() {
	if (started || typeof window === 'undefined') return;
	started = true;
	myHandModel.subscribe((hash) => {
		try {
			localStorage.setItem('myHandModel', hash ?? '');
		} catch {}
	});
	// missing bytes may arrive later (assetShare pull) — retry pending parses
	setInterval(() => {
		Object.values(get(peerHandModels)).forEach((hash) => ensureHandModel(hash));
	}, 2000);
}
