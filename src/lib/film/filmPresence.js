// 68 V7 — FILM PRESENCE: other peers see where a phone is filming from.
//
// A filming peer streams `filmpose` (~15 Hz, presence: never saved, never undone, mesh-wide like
// campreview) with its camera MARKER's live pose in the marker's PARENT frame. Every other peer
// poses that marker LOCALLY through prop playback (owner `filmpeer:<id>`): the base is captured on
// the first write, restored when the peer stops or leaves, and parked for every save — so nothing a
// filming peer does ever reaches a document. That one choice gives the two V7 views for free:
//   · the GIZMO is the marker itself (its body + frustum helper) moving through the scene;
//   · the LIVE SHOT is the existing camera PiP on that marker ("Watch the shot" on the toast
//     selects it, and the PiP follows the selected camera).
// The filming peer's own marker never moves (Film draws the live pose, the marker stays put), and a
// receiver that is itself filming the same camera skips it (Film's skipTargets), so two phones on
// one camera never fight over it.
//
// Imported statically by the dispatcher, so it stays small: stores + prop playback, the rest lazy.
import { writable, get } from 'svelte/store';
import { applyProps, releaseProps } from '../propPlayback';

/** peerId -> {uuid, rec, at}: who is filming through which camera @type {import('svelte/store').Writable<Record<string, {uuid: string, rec: boolean, at: number}>>} */
export const filmingPeers = writable({});

/** @param {string} peerId */
const owner = (peerId) => 'filmpeer:' + peerId;

/**
 * The dispatcher's applier (shape already checked by wireValidate).
 * @param {{peerId: string, off?: boolean, uuid?: string, pos?: number[], q?: number[], fov?: number, roll?: number, rec?: boolean}} data
 */
export function applyRemoteFilmPose(data) {
	const peerId = data.peerId;
	if (data.off || !data.uuid) return dropPeerFilm(peerId);
	const prev = get(filmingPeers)[peerId];
	if (prev && prev.uuid !== data.uuid) releaseProps(owner(peerId));
	/** @type {{target: string, path: string, value: any}[]} */
	const list = [];
	if (data.pos) list.push({ target: data.uuid, path: 'position', value: data.pos });
	if (data.q) list.push({ target: data.uuid, path: 'quaternion', value: data.q });
	if (Number.isFinite(data.fov)) list.push({ target: data.uuid, path: 'camera.fov', value: data.fov });
	if (Number.isFinite(data.roll)) list.push({ target: data.uuid, path: 'camera.roll', value: data.roll });
	applyProps(owner(peerId), list);
	const rec = !!data.rec;
	if (!prev || prev.uuid !== data.uuid || prev.rec !== rec) {
		filmingPeers.update((map) => ({ ...map, [peerId]: { uuid: data.uuid ?? '', rec, at: Date.now() } }));
		if (!prev || prev.uuid !== data.uuid) void announce(peerId, data.uuid);
	}
}

/** "X is filming through Cam — Watch the shot" (once per camera a peer picks up) @param {string} peerId @param {string} uuid */
async function announce(peerId, uuid) {
	try {
		const [{ showToast, userdata }, { objectsGroup }] = await Promise.all([import('../../stores/appStore'), import('../../stores/sceneStore')]);
		const roster = /** @type {any[]} */ (get(userdata) ?? []);
		const who = String(roster.find((u) => String(u?.[0] ?? '') === peerId)?.[1] ?? '') || 'A peer';
		const cam = /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', uuid);
		showToast(`${who} is filming through ${cam?.name || 'a camera'}`, [
			{
				// the camera PiP shows the selected camera: selecting it IS opening the live shot
				label: 'Watch the shot',
				action: () => void import('../objectActions').then((m) => m.selectObject(uuid))
			}
		]);
	} catch {
		/* presence only: a missing toast is not an error */
	}
}

/** a peer stopped filming or left: its camera goes back to where it stands @param {string} peerId */
export function dropPeerFilm(peerId) {
	releaseProps(owner(peerId));
	if (!get(filmingPeers)[peerId]) return;
	filmingPeers.update((map) => {
		const next = { ...map };
		delete next[peerId];
		return next;
	});
}

export function filmPresenceDebug() {
	return { filming: get(filmingPeers) };
}
