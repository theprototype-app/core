import { writable } from 'svelte/store';
// dependency-free helper, so importing it keeps this store a leaf
import { coarsePointer } from '../lib/inputDevice';
import { safeStorage } from '../lib/safeStorage';

/** @type {import('svelte/store').Writable<any>} */
export const globalScene = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const objectsGroup = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const showGrid = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const TControls = writable(null);
/** active gizmo transform mode (151): shared so the toolbar tint + 1/2/3 shortcuts agree */
export const transformMode = writable('translate');
/** @type {import('svelte/store').Writable<any[]>} */
export const lockedObjects = writable([]);
/** @type {import('svelte/store').Writable<any>} */
export const selectedObject = writable([]);
/** multi-select (13): uuids of every selected object; selectedObject stays the primary */
/** @type {import('svelte/store').Writable<string[]>} */
export const selectedObjects = writable([]);
/** marquee rectangle while shift-dragging in the viewport: {x0,y0,x1,y1} | null */
/** @type {import('svelte/store').Writable<any>} */
export const marqueeRect = writable(null);
/** VR world grab (71): the group wrapping all world content — scaled/rotated
 * LOCALLY by the both-grips gesture, identity outside VR, never replicated */
/** @type {import('svelte/store').Writable<any>} */
export const worldRig = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const backgroundColor = writable('#ffffff');
export const isLocked = writable(null);

/**
 * 21-E3: 'in play, pointer free' - the MENU SUBSTATE of `isLocked === true`, never
 * meaningful otherwise. True while a visible HUD screen with `input: 'menu'` has
 * released the pointer so the player can click it; the camera stays the player cam
 * and `isLocked` is NEVER written by the menu loop, which is what keeps the exit
 * debounce (Controls' false -> null + the 2s allowPlay lockout) structurally
 * unreachable from opening a menu. SINGLE WRITER: HudLayer. Everyone else reads.
 * @type {import("svelte/store").Writable<boolean>}
 */
export const playPointerFree = writable(false);
export const isVRMode = writable(false);
export const vrOverride = writable(false);
export const playerCam = writable(false);
export const editorCam = writable(false);
export const specators = writable([]);
/** @type {import('svelte/store').Writable<any>} */
export const globalCamera = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const camSave = writable(null);
/** @type {import('svelte/store').Writable<any>} */
export const globalRenderer = writable(null);

/**
 * 27-G (audit M13): the WebGL context has been lost. A lost context is SILENT — the
 * canvas simply stops updating while every other part of the app keeps responding, so it
 * reads to a user as "it froze" with nothing to act on. This drives the overlay that says
 * what happened and offers a way out.
 * @type {import('svelte/store').Writable<boolean>}
 */
export const contextLost = writable(false);
/** @type {import('svelte/store').Writable<any>} */
export const orbitControls = writable(null);
/**
 * 15-H11: bumped by `objectActions.flyTo` whenever something DELIBERATELY takes
 * the editor camera (focus, camera bookmarks, opening a note). A feature that
 * drives the camera continuously (the note-follow session) watches this counter
 * to know it has been handed over, instead of guessing from camera deviation —
 * guessing cannot tell an ordinary user PAN (which also moves the orbit target)
 * from someone else grabbing the view. It lives here because sceneStore is a
 * leaf: objectActions and annotationsHandler both already import it.
 */
export const cameraClaim = writable(0);
// peers' VR controller poses: peerId -> { left, right, active, ts }
/** @type {import('svelte/store').Writable<Record<string, any>>} */
export const peerHands = writable({});

// --- VR control suite ---
// which hand carries the quick-menu (the other hand is the pointer)
export const vrMenuHand = writable(
	typeof localStorage !== 'undefined' ? safeStorage.getItem('vrMenuHand') || 'right' : 'right'
);
export const vrMenuOpen = writable(false);
// snap-turn angle in degrees (15 / 30 / 45, or 0 = off — 155)
export const vrSnapAngle = writable(
	typeof localStorage !== 'undefined' ? parseInt(safeStorage.getItem('vrSnapAngle') || '45') : 45
);
// mirror snap-turn direction (155): left flick turns right and vice-versa
export const vrMirrorSnapTurn = writable(
	typeof localStorage !== 'undefined' && safeStorage.getItem('vrMirrorSnapTurn') === 'true'
);
// teleport locomotion (157): default ON; off disables the right-stick-up arc
export const vrTeleportEnabled = writable(
	typeof localStorage === 'undefined' || safeStorage.getItem('vrTeleportEnabled') !== 'false'
);
// VR sleeve palette (K1, experimental): a forearm strip of ghost primitives on
// the LEFT controller (mirrors right when the menu owns the left hand) —
// trigger-drag a ghost out to place it. DEFAULT OFF.
export const vrSleeveEnabled = writable(
	typeof localStorage !== 'undefined' && safeStorage.getItem('vrSleeveEnabled') === 'true'
);
// vertex grab style (182): default HOLD (trigger held = carry, release = drop);
// OFF = the toggle style (press to grab, press again to drop)
export const vrVertexHold = writable(
	typeof localStorage === 'undefined' || safeStorage.getItem('vrVertexHold') !== 'false'
);
// VR flying: left-stick movement follows the controller aim (pitch included)
export const vrFlying = writable(
	typeof localStorage !== 'undefined' && safeStorage.getItem('vrFlying') === 'true'
);
// passthrough preference (90): the VR button requests immersive-ar instead of
// immersive-vr on the NEXT session start (WebXR can't hot-swap modes)
export const vrPassthrough = writable(
	typeof localStorage !== 'undefined' && safeStorage.getItem('vrPassthrough') === 'true'
);
// radial menu open style (74): false = B/Y toggles (default), true = hold B/Y
// and release over a sector to activate it
export const vrMenuHold = writable(
	typeof localStorage !== 'undefined' && safeStorage.getItem('vrMenuHold') === 'true'
);
// native VR objects panel (101), opened from the radial Objects sector
export const vrObjectsPanelOpen = writable(false);
// VR chat panel (117), opened from the radial Chat sector
export const vrChatPanelOpen = writable(false);
// VR color palette (110), opened from Edit ▸ Color
export const vrPaletteOpen = writable(false);
// VR properties panel (112), opened from Edit ▸ Properties
export const vrPropsPanelOpen = writable(false);
// VR prefabs window (115), opened from Add ▸ Prefabs
export const vrPrefabsPanelOpen = writable(false);
// VR Edit Mesh side-menu (137), opened from Edit ▸ Edit Mesh (toggle)
export const vrEditMenuOpen = writable(false);
// 161: VR stretch mode — uuid being stretched (null = off) + the active axis (0=W/1=H/2=D)
/** @type {import('svelte/store').Writable<any>} */
export const vrStretchObject = writable(null);
export const vrStretchAxis = writable(0);
// 193: live [w,h,d] stretch factors, so the Edit>Stretch sliders show values
/** @type {import('svelte/store').Writable<number[]>} */
export const vrStretchFactors = writable([1, 1, 1]);
// VR Snap side-menu (156), opened from Edit ▸ Snap (toggle)
export const vrSnapMenuOpen = writable(false);
// VR Settings panel (187), opened from System ▸ Settings
export const vrSettingsPanelOpen = writable(false);
// VR peer-approval follower panel (211): auto-opens while presenting when a
// connection request is pending (desktop shows the Toasts approval card instead)
export const vrApprovePanelOpen = writable(false);
// 214: VR trigger tool mode from the radial Tools submenu — 'select' (single
// pick), 'box' (3D drag-box marquee) or 'draw' (freehand stroke)
export const vrToolMode = writable('select');
// B2.1 (roadmap 9): target VR refresh rate — 'auto' picks the highest supported
export const vrTargetHz = writable(
	typeof localStorage !== 'undefined' ? safeStorage.getItem('vrTargetHz') || 'auto' : 'auto'
);
vrTargetHz.subscribe((v) => {
	if (typeof localStorage !== 'undefined') safeStorage.setItem('vrTargetHz', String(v));
});
// B2.3: how everyone's hand-tracked peers render LOCALLY — 'hands' (cuboid bones)
// or 'spheres' (joint dots). A per-viewer preference, never replicated.
export const peerHandStyle = writable(
	typeof localStorage !== 'undefined' ? safeStorage.getItem('peerHandStyle') || 'hands' : 'hands'
);
peerHandStyle.subscribe((v) => {
	if (typeof localStorage !== 'undefined') safeStorage.setItem('peerHandStyle', String(v));
});
// Viewport render mode (V-2): LOCAL per-viewer, never replicated —
// 'shaded' | 'shaded-ao' (default on desktop) | 'wireframe' | 'custom'
//
// 'custom' (L1) renders the SCENE's authored post stack. It is never the BOOT
// default — at module eval no scene has arrived yet, so there is no stack to
// judge. The promotion happens when a stack does arrive, in
// scenePost.adoptCustomView(), which only ever promotes a viewer who has not
// explicitly picked a mode (see chooseViewMode).
function defaultViewMode() {
	const stored = typeof localStorage !== 'undefined' ? safeStorage.getItem('viewMode') : null;
	if (stored) return stored;
	// AO is a FULLSCREEN pass: a poor default on a phone GPU even when it works,
	// and several mobile drivers mis-compile it (the viewport then keeps showing a
	// stale frame until you leave AO mode — no console error). Coarse-pointer
	// devices therefore start in plain 'shaded'; the view-mode menu still offers AO.
	// `inputDevice` imports nothing, so this store stays a leaf.
	return coarsePointer() ? 'shaded' : 'shaded-ao';
}
export const viewMode = writable(defaultViewMode());
viewMode.subscribe((v) => {
	if (typeof localStorage !== 'undefined') safeStorage.setItem('viewMode', String(v));
});
// VR snap MODE (156): 'off' | 'grid' | 'surface' | 'rotation'
export const vrSnapMode = writable(
	typeof localStorage !== 'undefined' ? safeStorage.getItem('vrSnapMode') || 'off' : 'off'
);
// 115: true = the prefabs window is world-fixed (📌), false = lazy-follows the view
export const vrPrefabsPinned = writable(false);
// VR selection indicator style (110): wireframe (default) or the shell
export const vrWireframeSelection = writable(
	typeof localStorage === 'undefined' || safeStorage.getItem('vrWireframe') !== 'false'
);
// stats card on the pointer controller (102) — persisted so it re-attaches
export const vrStatsOpen = writable(
	typeof localStorage !== 'undefined' && safeStorage.getItem('vrStats') === 'true'
);
// true while an AR (passthrough) session presents — a LOCAL view mode: the
// scene background/fog go transparent so the room shows through; the
// replicated environment state is untouched
export const passthroughActive = writable(false);
// CO4: the ONE derivation feeding that signal — a session composites over the
// real world when its environmentBlendMode is not 'opaque' ('alpha-blend' on
// camera passthrough, 'additive' on see-through glasses). Pure and exported so
// Scene's session-start handler and the headless suite share the same rule.
/** @param {any} session @returns {boolean} */
export function sessionCompositesOverRoom(session) {
	return !!session && session.environmentBlendMode !== 'opaque';
}
// selection keeps working but the transform gizmo must NOT attach (sculpt mode:
// a visible gizmo invites accidental terrain moves mid-stroke). Lives in this
// leaf store so objectActions can gate on it without importing terrainSculpt
// (that static edge would close an import cycle).
export const gizmoSuppressed = writable(false);
/** @type {import('svelte/store').Writable<'move' | 'rotate'>} grab behavior; scale is always two-handed */
export const vrTransformMode = writable('move');
/** grab style (100): 'rigid' = controller-as-handle (default); 'move'/'rotate' = legacy gizmo grabs */
export const vrGrabStyle = writable(
	typeof localStorage !== 'undefined' ? safeStorage.getItem('vrGrabStyle') ?? 'rigid' : 'rigid'
);
/** handedness currently holding a grab ('left'|'right'|null) — gates that hand's stick */
export const vrGrabbedHand = writable(null);

// ---------------------------------------------------------------------------
// 26-B (hardening audit M6) — THE ONE PLACE A SCENE MUTATION IS ANNOUNCED.
//
// THE FINDING: `objectsGroup.update((v) => v)` sat at 117 call sites and eighteen
// subscribers hang off it, several of which TRAVERSE the whole tree (the Controls
// status-line walk, `refreshFilter`, `shadowDefaults.sweep`, the collider / camera /
// light helper sweeps, the shader reconcile, `sceneAssets.schedule`). A 1,000-object
// handshake therefore ran 1,000 pokes x ~8 traversals x 1,000 nodes — about 8M node
// visits, synchronously, on the receive path — which IS the reported "the window
// freezes while a big scene arrives". The same shape on `/clear` + restore and on any
// bulk import.
//
// The mutation itself is unchanged: `pokeScene()` still ends in the same identity
// update and every subscriber still sees the same value. What changes is HOW MANY
// times: at most one flush per microtask normally, and at most one per frame while an
// INGEST BATCH is open. N pokes inside one task become one.
//
// WHY A MICROTASK AND NOT rAF as the default: a microtask lands before the browser
// paints and before any `await` continuation, so nothing that reads a subscriber's
// output after yielding can observe a stale tree — and it still runs in a backgrounded
// tab, which rAF does not. The batch mode uses a TIMER for the same reason: a hidden
// tab throttles it to ~1Hz instead of stopping, so an ingest that starts and then loses
// focus still converges.
//
// This lives in the STORE and not in a new leaf on purpose: all 37 files that poke
// already import from here, so the seam costs no import edge anywhere — which matters,
// because the pokers include peerHandler, flowRuntime, autosave and history, i.e. every
// module inside the documented import cycles.
// ---------------------------------------------------------------------------

/** Bumped on every flush. A subscriber that caches an expensive traversal can key it
 * off this instead of re-walking; it is also what the 26-A meter samples. LOCAL — it
 * never replicates, saves or undoes. */
export const sceneRevision = writable(0);

/** One poke per this many ms while an ingest batch is open (~one frame at 60Hz). */
const POKE_BATCH_MS = 16;

let pokePending = false;
/** @type {any} */
let pokeTimer = null;
let batchDepth = 0;

function flushScenePoke() {
	pokePending = false;
	if (pokeTimer !== null) {
		clearTimeout(pokeTimer);
		pokeTimer = null;
	}
	sceneRevision.update((n) => n + 1);
	objectsGroup.update((value) => value);
}

/**
 * Announce that the THREE tree under `objectsGroup` changed. Coalesced — see above.
 * Every former `objectsGroup.update((v) => v)` call site calls this instead.
 */
export function pokeScene() {
	if (batchDepth > 0) {
		// batch mode: a timer already armed means this poke is already covered
		if (pokeTimer !== null) return;
		pokePending = true;
		pokeTimer = setTimeout(flushScenePoke, POKE_BATCH_MS);
		return;
	}
	if (pokePending) return;
	pokePending = true;
	queueMicrotask(flushScenePoke);
}

/**
 * Open an ingest batch: while one is open, pokes flush at most once per frame instead
 * of once per microtask. Refcounted, so nested batches (an import inside a handshake)
 * compose. ALWAYS pair with `endSceneBatch` in a `finally`.
 */
export function beginSceneBatch() {
	batchDepth++;
}

/** Close an ingest batch and flush immediately, so the last object of a batch is on
 * screen without waiting out a frame. */
export function endSceneBatch() {
	batchDepth = Math.max(0, batchDepth - 1);
	if (batchDepth === 0 && pokePending) flushScenePoke();
}

/** Flush any pending poke right now. For the paths that must not yield first (a
 * serializer about to read the tree) and for the suite. */
export function flushScenePokes() {
	if (pokePending) flushScenePoke();
}

/** Is an ingest batch open? Read by the suite and by the 26-A meter. */
export function sceneBatchOpen() {
	return batchDepth > 0;
}
