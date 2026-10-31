// 50 R1 — THE AR TABLE'S STATE, as a LEAF (svelte/store and nothing else).
//
// The runtime (arTable.js) reaches three, threlte's session toggle, the world rig and the
// interact path; the places that only have to STAND DOWN while a phone is placing a scene on a
// table (playMode's sim-on-play, the VR frame loop, the VR mode subscriber, Scene's VR trigger)
// need one boolean. They read it from here, so none of them imports the runtime — playMode sits
// in history's import subtree and vrControls is three thousand lines of headset code.
import { writable, get } from 'svelte/store';

/**
 * `phase`: 'off' (no AR table) · 'starting' (the session request is in flight) · 'finding'
 * (looking for a surface — the reticle) · 'placed' (the scene stands on the table) · VH2's ROOM mode:
 * 'room-a' (waiting for the tap on the agreed point) · 'room-b' (waiting for the tap along the agreed
 * edge) · 'room' (colocated: the scene stands 1:1 where the headsets in this room see it).
 * `playing`: Play was pressed (taps interact). `hit`: the reticle is on a flat surface this frame.
 * `overlay`: the session granted dom-overlay (the buttons are on screen; without it a tap places).
 * `scale`: world units -> metres on the table (0.02 = a 50 m world is a metre wide). `yaw`: radians.
 * `room`: the room key the phone joins (room mode only, '' otherwise). `note`: why the last room tap was
 * refused (cleared by the next step).
 * @typedef {{phase: 'off'|'starting'|'finding'|'placed'|'room-a'|'room-b'|'room', room: string, note: string, playing: boolean, hit: boolean, overlay: boolean, scale: number, yaw: number, error: string}} ArTableState
 */

/** @type {ArTableState} */
export const AR_OFF = { phase: 'off', room: '', note: '', playing: false, hit: false, overlay: false, scale: 1, yaw: 0, error: '' };

/** @type {import('svelte/store').Writable<ArTableState>} */
export const arTable = writable({ ...AR_OFF });

/** is an AR table session running (or being asked for)? — the one test every stand-down reads */
export function arTableActive() {
	return get(arTable).phase !== 'off';
}

/** is the AR session in VH2's room mode (calibrating or colocated)? @param {string} phase */
export function isRoomPhase(phase) {
	return phase === 'room-a' || phase === 'room-b' || phase === 'room';
}
