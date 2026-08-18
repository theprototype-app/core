// #20 P5: the "where the author left off" half of a saved scene — the SELECTION and any
// open mesh-edit / sculpt session with its element picks.
//
// THIS MODULE IMPORTS NOTHING, and the live modules are handed IN through
// `registerEditResumeSources` by a consumer that already imports them for real
// (Scene.svelte does, all five). Two reasons, in order of how much they bite:
//
//   A STATIC import would close a cycle. sessions.js imports this file and is reachable
//   from peerHandler, while faceEdit / meshEdit / objectActions all sit inside the
//   history-cycle family — the family that TDZ-crashes the SSR prerender.
//
//   A DYNAMIC import is the documented second-instance risk: a source-side
//   `import('./x')` can bind a second module instance once vite has HMR-timestamped the
//   app's copy, and reads then go against a parallel universe. (Not what bit the first
//   attempt here — that was reading `.uuid` off stores that hold a uuid STRING — but it
//   is why the registration seam is the right shape rather than a lucky one.)
//
// Same cure as 15-D's `registerVertexSessionRefresher`. The one exception is
// `workspace.js`, imported statically below: it is store-only (appStore + bottomDock,
// both leaves), so it closes no cycle.
import { snapshotWorkspace, applyWorkspace } from './workspace';
//
// Scope: selection, edit mode with its picks, and the panel LAYOUT. The layout is here
// rather than in localStorage because of when the user wants it back — only on an explicit
// Restore / auto-restore / file load, never on a plain reload (see workspace.js).
//
// EVERYTHING here is best-effort. A scene can legitimately be loaded where the object is
// gone, where the caps that gate a session refuse it (vrFaceCap is a real ceiling), or by
// a viewer with no edit rights. None of that may break the load.

/**
 * @typedef {object} EditResumeSources
 * @property {() => string[]} selection current selection uuids
 * @property {(uuid: string) => boolean} exists is this object still in the scene
 * @property {() => {uuid: string, submode: string, tris: number[]}|null} faceSession
 * @property {() => {uuid: string}|null} vertexSession
 * @property {() => {uuid: string}|null} sculptSession
 * @property {(uuids: string[]) => void} applySelection
 * @property {(uuid: string, submode: string, tris: number[]) => string|null} enterFace
 *   returns the submode actually entered, or null when refused
 * @property {(uuid: string) => boolean} enterVertex
 * @property {(uuid: string) => boolean} enterSculpt
 */

/** @type {EditResumeSources|null} */
let sources = null;

/**
 * Hand this module the live stores and actions. Returns a disposer.
 * @param {EditResumeSources} next
 */
export function registerEditResumeSources(next) {
	sources = next;
	return () => {
		if (sources === next) sources = null;
	};
}

/** Test seam: is anything wired? A save before this runs simply records nothing. */
export function editResumeReady() {
	return !!sources;
}

/**
 * @typedef {object} EditResume
 * @property {string[]} selection object uuids
 * @property {{kind: 'mesh'|'sculpt', uuid: string, submode?: string, tris?: number[]}} [edit]
 * @property {any} [layout] which panels/windows were open — see workspace.js
 */

/**
 * Capture the resume state, SYNCHRONOUSLY — `buildSessionPayload` is sync and runs
 * inside a park/restore try-finally, so it cannot await anything.
 *
 * Returns null when there is nothing worth saving, so the payload field is absent for an
 * ordinary scene and every existing file stays byte-identical.
 * @returns {EditResume|null}
 */
export function captureEditResume() {
	if (!sources) return null;
	try {
		const selection = (sources.selection() ?? []).slice();
		/** @type {any} */
		let edit = null;
		// faces and edges are SUBMODES of one session, so they save as one kind
		const face = sources.faceSession();
		const vertex = sources.vertexSession();
		const sculpt = sources.sculptSession();
		if (face?.uuid) {
			edit = {
				kind: 'mesh',
				uuid: face.uuid,
				submode: face.submode || 'faces',
				tris: (face.tris ?? []).slice()
			};
		} else if (vertex?.uuid) {
			edit = { kind: 'mesh', uuid: vertex.uuid, submode: 'vertices', tris: [] };
		} else if (sculpt?.uuid) {
			edit = { kind: 'sculpt', uuid: sculpt.uuid };
		}
		const layout = snapshotWorkspace();
		if (!selection.length && !edit && !layout) return null;
		return { selection, ...(edit ? { edit } : {}), ...(layout ? { layout } : {}) };
	} catch {
		return null;
	}
}

/**
 * Re-apply a resume record after a scene has loaded.
 * @param {any} record
 * @returns {{selection: number, edit: string|null, layout: boolean}} what was restored
 */
export function applyEditResume(record) {
	/** @type {{selection: number, edit: string|null, layout: boolean}} */
	const done = { selection: 0, edit: null, layout: false };
	if (!record || typeof record !== 'object') return done;
	// the LAYOUT needs no registered sources (it is store-only), so it is restored even
	// if the scene wiring is not up yet — and FIRST, so a panel that shows the selection
	// is already mounted when the selection lands in it
	if (record.layout) done.layout = applyWorkspace(record.layout);
	if (!sources) return done;
	try {
		const wanted = Array.isArray(record.selection) ? record.selection : [];
		const alive = wanted.filter((/** @type {string} */ uuid) => sources?.exists(uuid));
		if (alive.length) {
			// through the real selection path, so the gizmo gate, the viewer-permission
			// gate and the lock broadcast all run exactly as they do for a click
			sources.applySelection(alive);
			done.selection = alive.length;
		}

		const edit = record.edit;
		if (!edit?.uuid || !sources.exists(edit.uuid)) return done;

		if (edit.kind === 'sculpt') {
			if (sources.enterSculpt(edit.uuid)) done.edit = 'sculpt';
			return done;
		}
		if (edit.kind !== 'mesh') return done;

		const submode =
			edit.submode === 'edges' || edit.submode === 'vertices' ? edit.submode : 'faces';
		if (submode === 'vertices') {
			if (sources.enterVertex(edit.uuid)) done.edit = 'vertices';
			return done;
		}
		const tris = Array.isArray(edit.tris)
			? edit.tris.filter((/** @type {any} */ t) => Number.isInteger(t) && t >= 0)
			: [];
		done.edit = sources.enterFace(edit.uuid, submode, tris);
		return done;
	} catch {
		return done;
	}
}
