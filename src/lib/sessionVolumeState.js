// Roadmap 56 C13 — the session volumes' STORE, a leaf. The Explorer renders it on every open, so it
// sits in the boot graph; the runtime that fills it (sessionVolumes.js: the host side, pulls, copies,
// Save on host) is reached lazily — by the peer dispatcher on the first volume message and by the
// Explorer's actions — and stays out of boot.
import { writable, get } from 'svelte/store';

/**
 * @typedef {{id: string, name: string, kind: string, folderId: string | null, hash: string, size: number,
 *   thumbnail: string | null, createdAt: number}} SessionVolumeItem
 * @typedef {{id: string, peerId: string, name: string, host: string, scope: string, role: 'viewer'|'editor',
 *   folders: {id: string, name: string, parentId: string | null}[], items: SessionVolumeItem[],
 *   session: true, readOnly: true, rev: number, at: number}} SessionVolume
 */

/** The session volumes, one per host we joined. Never persisted: a session volume is a fact about
 * a live connection. @type {import('svelte/store').Writable<SessionVolume[]>} */
export const sessionVolumes = writable([]);

/** @param {string | null | undefined} id @returns {SessionVolume | null} */
export function sessionVolumeById(id) {
	if (!id) return null;
	return get(sessionVolumes).find((v) => v.id === id) ?? null;
}

/** Is a volume id a session volume's? (the `vol:` namespace is shared with mounted projects) @param {string | null | undefined} id */
export function isSessionVolumeId(id) {
	return typeof id === 'string' && id.startsWith('session-');
}
