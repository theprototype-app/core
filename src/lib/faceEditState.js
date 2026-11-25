// 102-boot-diet-2 (phase 2): THE BOOT HALF OF THE MESH EDITOR'S FACE MODE.
//
// faceEdit.js (~33 KB gz with triFrame) is a lazy chunk now (faceEditLazy.js loads it). What every
// page needs BEFORE anybody edits lives here instead: the stores the boot reads (is a session open,
// which mode, the local prefs and their persistence), the hook registries meshEdit / terrainSculpt /
// colliderEdit fill at THEIR module eval, and four small helpers with no session state.
// faceEdit.js imports and RE-EXPORTS every name below, so `fe.faceEditObject` (agent tools, the
// `faceEdit` debug hook, e2e) is the same store instance as before.
//
// THE PREF SUBSCRIBERS live here, not in faceEdit: three of them fire meshEdit's callbacks (the
// vertex wire rebuild, the gizmo-pref listeners) and must keep doing so while faceEdit is not loaded.
// Each keeps ONE subscriber in its old order: persist, then faceEdit's own reaction (`prefHooks`,
// set when faceEdit loads; it never needs the initial call -- no session exists before it loads),
// then meshEdit's listeners.
// A LEAF apart from the stores it reads: it must never import faceEdit (that is the whole point).
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { objectsGroup } from '../stores/sceneStore';
import { showToast, settingsOpen, settingsSection } from '../stores/appStore';
import { viewPrefs } from './viewPrefs';
import { meshPathSelect } from './meshToolParams';

const hasLS = typeof localStorage !== 'undefined';

/** faceEdit's own reactions to a pref change, registered at ITS module eval
 * @type {{wireframe?: (v: boolean) => void, triWire?: (v: boolean) => void, wireColor?: () => void, gizmoSpace?: (v: string) => void, gizmoEnabled?: (v: boolean) => void}} */
export const prefHooks = {};

// ---- D7: the VR face-edit triangle cap ------------------------------------------------------
/** Pure interaction-cost cap (meshBudget.js holds the SYNC ceilings). */
export const VR_FACE_CAP = 2500;
/** D7: user-editable face-edit triangle limit (Settings ▸ VR, local pref)
 * @type {import('svelte/store').Writable<number>} */
export const vrFaceCap = writable(hasLS ? parseInt(safeStorage.getItem('vrFaceCap') ?? '') || VR_FACE_CAP : VR_FACE_CAP);
if (hasLS) vrFaceCap.subscribe((value) => safeStorage.setItem('vrFaceCap', String(value)));

/** D7: over-limit / blocked-edit warning with a deep link into the Settings
 * VR section (works in noVR immediately; VR users see it on exit — on-device
 * surfacing stays a manual check). @param {string} message */
export function editCapToast(message) {
	showToast(message, [
		{
			label: 'Open Settings',
			action: () => {
				settingsSection.set('vr');
				settingsOpen.set(true);
			}
		}
	]);
}

/** @param {any} object */
export function triangleCount(object) {
	const pos = object?.geometry?.attributes?.position;
	if (!pos) return 0;
	return (object.geometry.index ? object.geometry.index.count : pos.count) / 3;
}

/** Is this object simple enough to face-edit in VR? D7: capped by the
 * user-editable vrFaceCap setting. @param {any} object */
export function vrFaceEditable(object) {
	const tris = triangleCount(object);
	return tris > 0 && tris <= get(vrFaceCap);
}

// ---- the registries (filled by other modules at their eval; read by faceEdit) --------------------
// A8: collider editing runs the edit tools on a SCENE-ROOT proxy, not on an object in objectsGroup —
// replicated messages (verts/meshgeo/lock) NO-OP on their side.
/** @type {any} */ let editProxy = null;
/** @param {any} object the live proxy mesh, or null to clear */
export function registerEditProxy(object) {
	editProxy = object;
}
/** objectsGroup lookup that also finds the registered edit proxy @param {string} uuid */
export function lookupEditable(uuid) {
	const found = get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
	if (found) return found;
	return editProxy && editProxy.uuid === uuid ? editProxy : null;
}

/** what meshEdit / terrainSculpt register; faceEdit reads it at call time */
export const editHooks = {
	/** D1: meshEdit's live-session refresh hook @type {((uuid: string) => void) | null} */
	vertexSessionRefresher: null,
	/** the sculpt session's weld-cache refresh @type {((uuid: string, object: any) => void) | null} */
	sculptCacheRefresher: null,
	/** meshEdit's vertex-mode overlay rebuild @type {(() => void) | null} */
	vertexWireRebuild: null,
	/** faceEdit: re-derive the open face session after a geometry swap @type {(() => void) | null} */
	faceSessionSwap: null,
	/** meshEdit's selection-history hooks (snapshot / apply / positions / reselect) @type {any} */
	vertexSelectionHistory: null,
	/** meshEdit's gizmo-pref listeners @type {(() => void)[]} */
	gizmoPrefListeners: /** @type {(() => void)[]} */ ([])
};
/** @param {(uuid: string) => void} fn */
export function registerVertexSessionRefresher(fn) {
	editHooks.vertexSessionRefresher = fn;
}
/** @param {(uuid: string, object: any) => void} fn */
export function registerSculptCacheRefresher(fn) {
	editHooks.sculptCacheRefresher = fn;
}
/** @param {() => void} fn */
export function registerVertexWireRebuild(fn) {
	editHooks.vertexWireRebuild = fn;
}
/** @param {any} hooks */
export function registerVertexSelectionHistory(hooks) {
	editHooks.vertexSelectionHistory = hooks;
}
/** @param {() => void} fn */
export function registerGizmoPrefListener(fn) {
	editHooks.gizmoPrefListeners.push(fn);
}

// ---- B2: the edit-session wireframe prefs (shared by vertex + face modes) -----------------------
/** wireframe overlay display toggle — honored by BOTH edit modes, local pref */
export const meshEditWireframe = writable(!hasLS || safeStorage.getItem('meshEditWireframe') !== 'false');
meshEditWireframe.subscribe((value) => {
	if (hasLS) safeStorage.setItem('meshEditWireframe', String(value));
	prefHooks.wireframe?.(value); // live toggle mid-session (face mode)
});

/** D3: mesh-edit hotkeys (E/I/G/S/B/F/X · W) enabled — local pref, default ON.
 * Read by MeshEditPopup (the local keydown), shortcuts.js (bare mesh-edit keys
 * never match the registry while a session owns them — F also focuses) and
 * editorNavigation (W/A/S/D/Q/E fly is suppressed while it's on; toggling the
 * pref OFF is the escape hatch that returns the camera keys, quiz 15-D3). */
export const meshEditHotkeys = writable(!hasLS || safeStorage.getItem('meshEditHotkeys') !== 'false');
meshEditHotkeys.subscribe((value) => {
	if (hasLS) safeStorage.setItem('meshEditHotkeys', String(value));
});

/** Show the object SELECTION OUTLINE while mesh-editing — local pref, default
 * OFF (the outline is a post pass composited over the handles). Read by Outline.svelte. */
export const meshEditOutline = writable(hasLS && safeStorage.getItem('meshEditOutline') === 'true');
meshEditOutline.subscribe((value) => {
	if (hasLS) safeStorage.setItem('meshEditOutline', String(value));
});

/** Show the raw TRIANGULATION in the edit wireframe — local pref, default OFF (the default draws
 * the QUAD structure; a quad's diagonal is a triangulation artifact the tools refuse to touch). */
export const meshEditTriWire = writable(hasLS && safeStorage.getItem('meshEditTriWire') === 'true');
meshEditTriWire.subscribe((value) => {
	if (hasLS) safeStorage.setItem('meshEditTriWire', String(value));
	// the edge set differs, so this rebuilds rather than toggling visibility
	prefHooks.triWire?.(value);
	editHooks.vertexWireRebuild?.();
});

/** 18-A: the overlay colour is baked into its material at BUILD time (and 'auto'
 * re-reads the object's luminance), so a colour change rebuilds both overlays. */
let lastEditWireColor = get(viewPrefs).editWireColor;
viewPrefs.subscribe((prefs) => {
	if (prefs.editWireColor === lastEditWireColor) return;
	lastEditWireColor = prefs.editWireColor;
	prefHooks.wireColor?.();
	editHooks.vertexWireRebuild?.();
});

// ---- face-edit MODE state ------------------------------------------------------------------------
/** @type {import('svelte/store').Writable<string|null>} uuid in face-edit mode */
export const faceEditObject = writable(null);
/** highlighted face index (ray/selection), or -1 @type {import('svelte/store').Writable<number>} */
export const faceEditHighlight = writable(-1);
/** armed op for the next commit (B4 adds the one-shots)
 * @type {import('svelte/store').Writable<'extrude'|'inset'|'move'|'delete'|'subdivide'|'flip'|'bridge'|'loopcut'|'knife'>} */
export const faceEditOp = writable('move');
/** live op amount, stick-driven @type {import('svelte/store').Writable<number>} */
export const faceEditAmount = writable(0.3);
/** 176: desktop auto-apply the active extrude/inset op on face click */
export const faceAutoApply = writable(true);
/** 19-A P2: UI/e2e mirror of the LIVE op adjust — `{op, params}` or null
 * @type {import('svelte/store').Writable<any>} */
export const opAdjustState = writable(null);
/** face-select granularity (see faceEdit's granularity()): 'quad' is the DEFAULT since 15-G; the
 * RETIRED 'polygon' alias still reads as 'triangle'.
 * @type {import('svelte/store').Writable<'quad'|'face'|'triangle'|'shell'|'object'|'polygon'>} */
export const faceEditGranularity = writable('quad');
/** Multi mode: triggers ACCUMULATE picks; ops apply to the whole set */
export const faceEditMulti = writable(false);
/** accumulated selected tri indices (into the session frame) in Multi mode @type {import('svelte/store').Writable<number[]>} */
export const faceEditSelectedTris = writable(/** @type {number[]} */ ([]));
/** the raw triangle under the ray/cursor (for polygon picking), or -1 */
export const faceEditHoverTri = writable(-1);
/** 'faces' picks coplanar units, 'edges' picks single edges (M4)
 * @type {import('svelte/store').Writable<'faces'|'edges'>} */
export const faceEditSubmode = writable('faces');
/** selected edge keys, canonical `ka|kb` @type {import('svelte/store').Writable<string[]>} */
export const edgeEditSelected = writable(/** @type {string[]} */ ([]));
/** the edge under the cursor, or '' @type {import('svelte/store').Writable<string>} */
export const edgeEditHover = writable('');
/** the knife's pending polyline (see faceEdit's knife section)
 * @type {import('svelte/store').Writable<{points: number[][], from: number[], to: number[]}|null>} */
export const knifePreview = writable(null);

// ---- E9: the gizmo prefs (shared by every element mode) ---------------------------------------
/** E9: face-gizmo space — 'local' = the FACE basis (Z = normal), 'world' = world axes. Persisted
 * local pref. NOTE three r185: scale mode always orients local, whatever `.space` says.
 * @type {import('svelte/store').Writable<'local'|'world'>} */
export const faceGizmoSpace = writable(hasLS && safeStorage.getItem('faceGizmoSpace') === 'world' ? 'world' : 'local');
faceGizmoSpace.subscribe((value) => {
	if (hasLS) safeStorage.setItem('faceGizmoSpace', String(value));
	prefHooks.gizmoSpace?.(value); // live flip while the face gizmo is seated
	// vertex mode seats its own proxy (meshEdit) — it re-reads this store on change
	editHooks.gizmoPrefListeners.forEach((fn) => fn());
});

/** Whether a transform gizmo seats at all, in EVERY element mode (vertices/edges/faces). One
 * switch rather than three; local pref, default ON.
 * @type {import('svelte/store').Writable<boolean>} */
export const meshGizmoEnabled = writable(hasLS ? safeStorage.getItem('meshGizmoEnabled') !== '0' : true);
meshGizmoEnabled.subscribe((value) => {
	if (hasLS) safeStorage.setItem('meshGizmoEnabled', value ? '1' : '0');
	if (typeof window === 'undefined') return;
	prefHooks.gizmoEnabled?.(value); // seat / drop the face gizmo, restore a hidden pick
	editHooks.gizmoPrefListeners.forEach((fn) => fn());
});

/** 99 K8: the clicked element is a path target: Ctrl alone (Shift / Cmd keep the plain add), or any click under the
 * Path toggle. Here (not in faceEdit.js) so the viewport's click handler asks it without the lazy chunk
 * @param {{ ctrlKey?: boolean, shiftKey?: boolean, metaKey?: boolean }} event */
export function pathGesture(event) {
	return get(meshPathSelect) || (!!event.ctrlKey && !event.shiftKey && !event.metaKey);
}
