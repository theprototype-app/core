import { writable, derived, get } from 'svelte/store';

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
/**
 * 15-O: PIN the properties sidebar. Unpinned (default) a click just SELECTS —
 * properties open on double-click, the context-menu "Properties" entry or the
 * object-list ⓘ. Pinned, the panel stays up and follows you: object selected →
 * its properties, nothing selected → the scene's (deselecting no longer closes
 * it). LOCAL preference.
 */
export const inspectorPinned = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('inspectorPinned') === 'true'
);
if (typeof localStorage !== 'undefined')
	inspectorPinned.subscribe((v) => {
		try {
			localStorage.setItem('inspectorPinned', String(v));
		} catch {}
	});
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
/** @type {import('svelte/store').Writable<any>} */
export const username = writable(null);

// local player's avatar configuration (userdata slot 5, replicated to peers)
const storedAvatarConfig =
	typeof localStorage !== 'undefined' ? localStorage.getItem('avatarConfig') : null;
/** @type {import('svelte/store').Writable<{body: string, hat: string, face: string}>} */
export const avatarConfig = writable(
	storedAvatarConfig ? JSON.parse(storedAvatarConfig) : { body: '#4f83cc', hat: 'none', face: 'label' }
);
export const characterModalOpen = writable(false);
/** Profile Settings modal open state (shared so the logo/menu can close it). */
export const profileSettingsOpen = writable(false);
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
 * 16-Q2: DEEP LINK into a Configure Scene section ("More snapping settings…",
 * "Grid & axes settings…", "Manage saved views…"). Deliberately NOT showSidebar:
 * that TOGGLES the scene view, so clicking a deep link while the panel was already
 * open used to CLOSE it. This only ever opens, then names the section to expand +
 * scroll to (Section.svelte watches the store and clears it).
 * @param {string} label the Section label to reveal
 */
export function openSceneSection(label) {
	libraryClose.set(true);
	const wasOpen = !get(inspectorClose) && get(inspectorKind) === 'scene';
	inspectorKind.set('scene');
	inspectorClose.set(false);
	// let the panel mount before asking a section to scroll (it may not exist yet)
	setTimeout(() => inspectorScrollTo.set(label), wasOpen ? 0 : 140);
}

/**
 * Close the inspector only when it shows the selection — deselect, lock and
 * delete paths must not close an open scene view.
 */
export function closeSelectionInspector() {
	if (get(inspectorKind) !== 'selection') return;
	// 15-O: a PINNED panel never closes itself — with nothing selected there is
	// still something to show, so it falls back to the scene's settings.
	if (get(inspectorPinned) && !get(inspectorClose)) {
		inspectorKind.set('scene');
		return;
	}
	inspectorClose.set(true);
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

// On an official/hosted domain (theprototype.app/.io, *.pages.dev) the "local
// version" banner text is wrong, so it defaults to null there (the cloud plugin can
// still set its own). Elsewhere (localhost/self-host) it shows the local notice.
const isHostedDomain =
	typeof location !== 'undefined' && /(theprototype\.(app|io)|\.pages\.dev)$/i.test(location.hostname);
/**
 * First-run info banner (Toasts.svelte), dismissed once via the `hasSeenDisclaimer`
 * flag. Open-core seam (roadmap #13 batch M): the cloud plugin loaded via
 * `VITE_CLOUD_PLUGIN` can `appNotice.set(null)` to remove the banner, or set its own
 * `{ text, ctaLabel?, ctaUrl? }` to rebrand it. `null` => no banner.
 * @type {import('svelte/store').Writable<{ text: string, ctaLabel?: string, ctaUrl?: string } | null>}
 */
export const appNotice = writable(
	isHostedDomain
		? null
		: {
				text: 'You are running the local, open-source version of theprototype.',
				ctaLabel: 'Source',
				ctaUrl: 'https://github.com/theprototype-app/core'
			}
);

/**
 * Cloud account identity pushed by the plugin (cloudApi.setAccountIdentity) — used as
 * the DEFAULT collaborative username/avatar (and shown in the profile menu) when the
 * user hasn't set a custom one. null = signed out. (roadmap #14 profile-fixes)
 * @type {import('svelte/store').Writable<{ username?: string, avatar?: string, email?: string } | null>}
 */
export const cloudIdentity = writable(null);

// modules manager modal
export const modulesOpen = writable(false);

// sessions manager modal (50)
export const sessionsOpen = writable(false);

/**
 * 15-B6: is ANY app modal open? App modals are non-modal native `<dialog>`s
 * (they must stay non-modal so body-portalled dropdowns/toasts keep working),
 * which means the page behind them is NOT inert and window key handlers still
 * fire — WASD flew the camera while Settings was open. One derived signal, so
 * shortcuts.js / editorNavigation.js / inputRuntime.js all gate the same way.
 * Drawers, floating windows and menus are deliberately NOT included (they're
 * meant to coexist with viewport work).
 */
export const anyModalOpen = derived(
	[settingsOpen, sessionsOpen, modulesOpen, characterModalOpen, profileSettingsOpen, meshGenModalOpen],
	([$settings, $sessions, $modules, $character, $profile, $meshGen]) =>
		!!$settings || !!$sessions || !!$modules || !!$character || !!$profile || !!$meshGen
);

// viewport right-click menu (77): { x, y, point: [x,y,z] } | null — rendered
// by ViewportMenu; Scene routes right-taps here (or to objectContextMenu)
/** @type {import('svelte/store').Writable<any>} */
export const viewportMenu = writable(null);
// Add-object SEARCH popover (77): { x, y, point: [x,y,z] | null } | null
/** @type {import('svelte/store').Writable<any>} */
export const addMenu = writable(null);
// Scene publishes an opener that anchors the Add-search popover to the CURRENT
// pointer and resolves the world point under it (object hit, else the ground
// plane) — so Shift+A spawns where you are looking, exactly like the right-click
// Add menu does. Scene owns the raycaster, so the ray logic stays there.
// Signature: () => boolean (false = no pointer seen yet, caller should fall back)
/** @type {import('svelte/store').Writable<null | (() => boolean)>} */
export const addMenuOpener = writable(null);

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

// Shift+A quick-add (the cursor-anchored Add popover). Opt-in, persisted; OFF by
// default — Shift is a camera-strafe modifier in fly mode, so the shortcut only
// exists for users who ask for it in Settings.
export const enableShiftAdd = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('enableShiftAdd') === 'true'
);
enableShiftAdd.subscribe((on) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('enableShiftAdd', String(on));
});

// E1 (roadmap #13): notification center — a persisted history of everything that
// flashed as a toast, so a message missed (or dismissed while a modal was open) is
// still recoverable. The bell + panel live in NotificationCenter.svelte.
/** @type {import('svelte/store').Writable<any[]>} */
export const notifications = writable(
  (() => {
    if (typeof localStorage === 'undefined') return [];
    try {
      return JSON.parse(localStorage.getItem('notifications') || '[]');
    } catch {
      return [];
    }
  })()
);
notifications.subscribe((list) => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem('notifications', JSON.stringify(list.slice(-50)));
  } catch {
    /* storage full / disabled */
  }
});
/** count of notifications arrived since the center was last opened */
export const notificationsUnread = writable(0);
/** Inspector property search (PFX-C follow-up): non-empty = Sections filter
 * themselves by their rendered text (Section.svelte reads this). LOCAL. */
export const inspectorFilter = writable('');
/** 16-Q2: a Section LABEL to expand + scroll into view (set by `openSceneSection`,
 * consumed and cleared by the matching Section).
 * @type {import('svelte/store').Writable<string|null>} */
export const inspectorScrollTo = writable(null);
/** the notification center panel open state */
export const notificationCenterOpen = writable(false);
/** E2: the scene-notes drawer (lists every annotation) open state */
export const notesDrawerOpen = writable(false);

// CN drawer redesign (2026-07-25): the chevron under the Connect pill opens ONE
// tabbed drawer — Info (connection/server), Rooms (cloud plugin), Toasts (a view of
// the notifications feed). Shared so Toasts.svelte can suppress live pop-ups while
// the Toasts tab is open, and so a Rooms shortcut button can open it on that tab.
export const connectDrawerOpen = writable(false);
/** @type {import('svelte/store').Writable<'info'|'rooms'|'toasts'>} */
export const connectDrawerTab = writable('info');
/** DOCKED: Connect.svelte measures whether the centred pill would overlap the corner
 * chrome (logo left, peers/profile right). When it would, the pill snaps to a
 * full-width top bar ("docked") — the Rooms shortcut hides, and the logo/profile
 * chrome shifts DOWN by `connectBarHeight` so it clears the bar (and its tab strip
 * when pinned). Runtime-only (no persistence). */
export const connectDocked = writable(false);
/** Height (px) the docked Connect bar occupies at the top — pill height plus its tab
 * strip when the drawer is pinned/open. Chrome offsets its top by this so nothing
 * overlaps. 0 when not docked. */
export const connectBarHeight = writable(0);

/** Allow undocking Flow/Explorer on touch/limited-width devices. Default OFF — floating
 * windows have no room on a phone, so those panels stay docked and the undock button is
 * hidden. Toggle in Settings; a `.allow-undock` root class drives the CSS, and the
 * panels read this to decide whether to force-dock on load. Persisted. */
export const mobileUndockAllowed = writable(
  typeof localStorage !== 'undefined' ? localStorage.getItem('mobileUndockAllowed') === 'true' : false
);
if (typeof localStorage !== 'undefined') {
  mobileUndockAllowed.subscribe((v) => {
    try { localStorage.setItem('mobileUndockAllowed', v ? 'true' : 'false'); } catch { /* */ }
    if (typeof document !== 'undefined') document.documentElement.classList.toggle('allow-undock', !!v);
  });
}
/** PINNED: keep the drawer's tab bar (+ status) visible even when the body is
 * collapsed, so it acts as a persistent mini-bar under the pill. Persisted. */
export const connectDrawerPinned = writable(
  typeof localStorage !== 'undefined' ? localStorage.getItem('connectDrawerPinned') === 'true' : false
);
/** Route toasts into the drawer's Toasts tab only — hide the viewport pop-ups even
 * when the drawer is closed (they still live in the Toasts tab + notification bell).
 * Persisted. */
export const toastsInDrawerOnly = writable(
  typeof localStorage !== 'undefined' ? localStorage.getItem('toastsInDrawerOnly') === 'true' : false
);
if (typeof localStorage !== 'undefined') {
  connectDrawerPinned.subscribe((v) => {
    try { localStorage.setItem('connectDrawerPinned', v ? 'true' : 'false'); } catch { /* */ }
  });
  toastsInDrawerOnly.subscribe((v) => {
    try { localStorage.setItem('toastsInDrawerOnly', v ? 'true' : 'false'); } catch { /* */ }
  });
}
/** Show the "Local objects" section in the object list (viewer WIP / editor-shareable
 * objects). OFF by default — auto-enabled when the first local object is made; also
 * togglable under the object-list filter cog. Persisted. */
export const showLocalObjects = writable(
  typeof localStorage !== 'undefined' ? localStorage.getItem('showLocalObjects') === 'true' : false
);
if (typeof localStorage !== 'undefined') {
  showLocalObjects.subscribe((v) => {
    try {
      localStorage.setItem('showLocalObjects', v ? 'true' : 'false');
    } catch {
      /* storage disabled */
    }
  });
}

/** Show the "Rooms" shortcut button in the Connect pill (only meaningful when the
 * cloud plugin is present). Default ON for discoverability; users can hide it and
 * still reach rooms via the chevron drawer's Rooms tab. Persisted. */
export const showRoomsButton = writable(
  typeof localStorage !== 'undefined' ? localStorage.getItem('showRoomsButton') !== 'false' : true
);
if (typeof localStorage !== 'undefined') {
  showRoomsButton.subscribe((v) => {
    try {
      localStorage.setItem('showRoomsButton', v ? 'true' : 'false');
    } catch {
      /* storage disabled */
    }
  });
}
let _notifId = 0;
/**
 * Append a notification to the history + bump the unread badge.
 * @param {string} text @param {string} [kind]
 */
export function pushNotification(text, kind = 'info') {
  if (!text) return;
  const entry = { id: `n${Date.now()}_${++_notifId}`, text, ts: Date.now(), kind };
  notifications.update((list) => [...list, entry].slice(-50));
  notificationsUnread.update((c) => c + 1);
}

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
  // E1: every toast also lands in the notification history
  pushNotification(message, actions ? 'action' : 'info');
}

export function clearToast(toast) {
  toastStore.update((toast) => []);
}

/**
 * 15-L: a STICKY INFO toast — informational, visually distinct (blue accent),
 * never auto-dismissed, and identified by `id` so a state-driven source can
 * add/remove exactly its own entry. This is how the restore-session prompt and
 * the first-run notice ride the normal toast pipeline: they get the shared card
 * chrome AND show up in the Connect drawer's Toasts tab, which hand-rolled
 * blocks never did.
 * @param {string} id stable key (also dedupes re-adds)
 * @param {string} text
 * @param {{label: string, action: () => void}[]=} actions
 * @param {(() => void)=} onDismiss side effect for the ✕ (e.g. persist "seen")
 * @param {boolean=} noClose 15-P2: a genuine FORK renders no ✕ at all — a
 *   dismiss that silently picks one branch is the auto-decide trap in
 *   miniature; the user must click one of the actions (share-or-stash)
 */
export function showInfoToast(id, text, actions, onDismiss, noClose) {
  toastStore.update((list) => {
    if (list.some((entry) => entry && entry.id === id)) return list; // already up
    return [...list, { id, text, actions: actions ?? [], kind: 'info', sticky: true, onDismiss, noClose: !!noClose }];
  });
}

/** Remove a toast by its `id` (no-op when absent). @param {string} id */
export function dismissToastById(id) {
  toastStore.update((list) => list.filter((entry) => !(entry && entry.id === id)));
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
