// 36-avatars: the small LOCAL state the rigged avatars share with the rest of the UI. A leaf
// (svelte/store only). Nothing here replicates.

import { writable } from 'svelte/store';

/**
 * Which peers' hands the rigged body is currently holding with its IK (so Player stops drawing the
 * floating controller box for that side — the body's hand IS the marker). Written on CHANGE only.
 * @type {import('svelte/store').Writable<Record<string, Record<string, boolean>>>}
 */
export const avatarIkPeers = writable({});

/**
 * The customise panel's live preview of YOUR character: the draft config and where it stands.
 * null = no preview. Rendered by Player, LOCAL only (golden rule 5: scene root, never objectsGroup).
 * @type {import('svelte/store').Writable<null | {config: any, photo: string, position: number[], yaw: number, walk: boolean}>}
 */
export const avatarPreview = writable(null);

/** live RiggedAvatar instances by root name, for the debug hook / e2e @type {Map<string, any>} */
export const avatarInstances = new Map();

/** e2e/debug: every rigged body's state */
export function avatarsDebug() {
	/** @type {Record<string, any>} */
	const out = {};
	for (const [name, a] of avatarInstances) out[name] = a.state();
	return out;
}
