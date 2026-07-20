import { writable, get } from 'svelte/store';

/** @type {import('svelte/store').Writable<any>} */
export const settingsOpen = writable(null);
// section to expand when the settings modal opens (e.g. 'shortcuts' via Ctrl+/)
/** @type {import('svelte/store').Writable<any>} */
export const settingsSection = writable(null);
// unified inspector (phase 64): one drawer serves the selection (mesh/light/
// group) and the scene. `inspectorKind` picks the content, `inspectorClose`
// the visibility — the legacy per-panel flags collapsed into this pair.
export const inspectorClose = writable(true);
/** @type {import('svelte/store').Writable<'selection'|'scene'|'file'>} */
export const inspectorKind = writable('selection');
export const flowGraphClose = writable(true);
// Flow Code: an editable JSON view of the flow graph (roadmap 9). Added via the
// Flow tab "+"; a standalone floating window that can tab-group with Flow.
export const flowCodeClose = writable(true);
// Animation window (author + preview LOCAL transform movements) — Flow "+" menu.
export const animationClose = writable(true);
// Explorer asset browser (95) — folder hud button toggles it
export const explorerClose = writable(true);
export const objectListClose = writable(true);
export const chatHidden = writable('hidden');
// AI assistant (roadmap #10): '' = window open, 'hidden' = closed (mirrors chat).
export const aiAssistantHidden = writable('hidden');
// Quick prompt pill — toggled by the backquote shortcut; session-only (not persisted).
export const aiPromptBarOpen = writable(false);
// Mesh-generation modal (roadmap #11): { position: number[]|null } when open, else null.
/** @type {import('svelte/store').Writable<any>} */
export const meshGenModalOpen = writable(null);
export const libraryClose = writable(true);
export const userdata = writable([]);
export const username = writable(null);

// local player's avatar configuration (userdata slot 5, replicated to peers)
const storedAvatarConfig =
	typeof localStorage !== 'undefined' ? localStorage.getItem('avatarConfig') : null;
/** @type {import('svelte/store').Writable<{body: string, hat: string, face: string}>} */
export const avatarConfig = writable(
	storedAvatarConfig ? JSON.parse(storedAvatarConfig) : { body: '#4f83cc', hat: 'none', face: 'label' }
);
export const characterModalOpen = writable(false);
/** @type {import('svelte/store').Writable<any>} */
export const peers = writable(null);
export const toggleExpand = writable(null);
export const closeMenu = writable(true);
export const specatorMode = writable(false);

// update the sidebar visibility
/** @param {'properties'|'lightProperties'|'scene'|'library'} store */
export function showSidebar(store) {
	if (store === 'library') {
		// Library TOGGLES: a second click closes it
		if (!get(libraryClose)) {
			libraryClose.set(true);
			return;
		}
		inspectorClose.set(true);
		// The delay adds cool effect
		setTimeout(() => libraryClose.set(false), 50);
		return;
	}
	// 'properties' and 'lightProperties' are both selection targets now —
	// the inspector derives its sections from the selected object itself
	const kind = store === 'scene' ? 'scene' : 'selection';
	const open = !get(inspectorClose);
	// Configure Scene TOGGLES; selection stays open-only (clicks must never close it)
	if (store === 'scene' && open && get(inspectorKind) === 'scene') {
		inspectorClose.set(true);
		return;
	}
	libraryClose.set(true);
	if (open && get(inspectorKind) === kind) return; // already showing this target
	inspectorClose.set(true);
	// The delay adds cool effect
	setTimeout(() => {
		inspectorKind.set(kind);
		inspectorClose.set(false);
	}, 50);
}

/**
 * Close the inspector only when it shows the selection — deselect, lock and
 * delete paths must not close an open scene view.
 */
export function closeSelectionInspector() {
	if (get(inspectorKind) === 'selection') inspectorClose.set(true);
}

// Snapshot/restore of panel visibility, used when opening Settings or entering
// spectate mode. A single snapshot slot: hidePanels() while already hidden is a
// no-op, so nested calls (settings during spectate) don't clobber the snapshot.
/** @type {any} */
let panelSnapshot = null;

/** @param {string[]} keep - panel keys to leave untouched: 'menu' | 'library' | 'inspector' | 'flow' | 'objectList' | 'chat' */
export function hidePanels(keep = []) {
	if (panelSnapshot) return;
	panelSnapshot = {
		menu: get(closeMenu),
		library: get(libraryClose),
		inspector: get(inspectorClose),
		inspectorKind: get(inspectorKind),
		flow: get(flowGraphClose),
		objectList: get(objectListClose),
		chat: get(chatHidden)
	};
	if (!keep.includes('menu')) closeMenu.set(true);
	if (!keep.includes('library')) libraryClose.set(true);
	if (!keep.includes('inspector')) inspectorClose.set(true);
	if (!keep.includes('flow')) flowGraphClose.set(true);
	if (!keep.includes('objectList')) objectListClose.set(true);
	if (!keep.includes('chat')) chatHidden.set('hidden');
}

export function restorePanels() {
	if (!panelSnapshot) return;
	closeMenu.set(panelSnapshot.menu);
	libraryClose.set(panelSnapshot.library);
	inspectorKind.set(panelSnapshot.inspectorKind);
	inspectorClose.set(panelSnapshot.inspector);
	flowGraphClose.set(panelSnapshot.flow);
	objectListClose.set(panelSnapshot.objectList);
	chatHidden.set(panelSnapshot.chat);
	panelSnapshot = null;
}

// context menu state for the object list: { x, y, uuid, locked } | null
/** @type {import('svelte/store').Writable<any>} */
export const objectContextMenu = writable(null);
// uuid of the object being renamed inline in the object list
/** @type {import('svelte/store').Writable<any>} */
export const renamingObject = writable(null);

export const fixLight = writable(false);
export const pendingApprovals = writable([]);
export const waitingForApproval = writable([]);
/** @type {import('svelte/store').Writable<any[]>} strings or {text, actions} */
export const toastStore = writable([]);

// modules manager modal
export const modulesOpen = writable(false);

// sessions manager modal (50)
export const sessionsOpen = writable(false);

// viewport right-click menu (77): { x, y, point: [x,y,z] } | null — rendered
// by ViewportMenu; Scene routes right-taps here (or to objectContextMenu)
/** @type {import('svelte/store').Writable<any>} */
export const viewportMenu = writable(null);
// Add-object SEARCH popover (77): { x, y, point: [x,y,z] | null } | null
/** @type {import('svelte/store').Writable<any>} */
export const addMenu = writable(null);

// Scene registers its context-menu opener here so touch/HUD (the mobile "+"
// button, a canvas long-press) can open the same viewport/object menu without a
// right-click. Signature: (clientX, clientY, forceEmpty?, menuX?, menuY?) => void
// — the ray casts from clientX/Y; menuX/Y (default to clientX/Y) position the menu
// so a HUD button can anchor the menu to itself while raying from screen-centre.
/** @type {import('svelte/store').Writable<((x: number, y: number, forceEmpty?: boolean, menuX?: number, menuY?: number) => void) | null>} */
export const viewportMenuOpener = writable(null);

// viewport object SEARCH popover (125): { x, y } | null — find + focus a scene
// object. Opt-in via a setting; the viewport menu entry hides when off.
/** @type {import('svelte/store').Writable<any>} */
export const objectSearch = writable(null);
export const objectSearchEnabled = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('objectSearchEnabled') === 'true'
);
objectSearchEnabled.subscribe((on) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('objectSearchEnabled', String(on));
});

// advanced mode: reveals system objects (module content, environment rig)
// in the object list behind a System filter chip
export const advancedMode = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('advancedMode') === 'true'
);
advancedMode.subscribe((on) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('advancedMode', String(on));
});

// object list: reveal the environment group behind an Environment chip (70.4)
export const showEnvInList = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('showEnvInList') === 'true'
);
showEnvInList.subscribe((on) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('showEnvInList', String(on));
});

// A3 (roadmap #13): show the physics simulation transport (SimControls HUD).
// Default OFF — the standalone ▶/⏸/⏹ HUD confuses with the main play button in
// Controls; the P shortcut still starts/stops the sim when this is hidden.
export const showSimControls = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('showSimControls') === 'true'
);
showSimControls.subscribe((on) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('showSimControls', String(on));
});

// N4: Explorer 3D model preview — a rotatable inline preview in Properties + a
// popup on open. Global (all of Explorer), persisted; off by default.
export const enable3dPreview = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('enable3dPreview') === 'true'
);
enable3dPreview.subscribe((on) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('enable3dPreview', String(on));
});

/**
 * Plain string = 3s info toast. Pass `actions` ([{label, action}]) for a
 * sticky decision toast (15s) with buttons.
 * @param {string} message @param {{label: string, action: () => void}[]=} actions
 */
export function showToast(message, actions) {
  toastStore.update((toast) => {
    // U-3: collapse duplicate plain-string toasts so a repeated message can't
    // spam the stack (action toasts are always distinct, never deduped)
    if (!actions && toast.some((entry) => entry === message)) return toast;
    return [...toast, actions ? { text: message, actions } : message];
  });
}

export function clearToast(toast) {
  toastStore.update((toast) => []);
}

export const loading = writable([]);
export const loadingcount = writable([]);
export const loadingFile = writable([]);

export const messages = writable([]);

export function addMessage(newMessage, type, sender) {
	messages.update((currentMessages) => [
		...currentMessages,
		{
			id: messages.length,
			text: newMessage.message,
			sender: newMessage.sender,
			type: newMessage.type,
			ts: Date.now() // local receive time — display only, never replicated
		}
	]);
}
