import { writable, get } from 'svelte/store';

/** @type {import('svelte/store').Writable<any>} */
export const settingsOpen = writable(null);
// section to expand when the settings modal opens (e.g. 'shortcuts' via Ctrl+/)
/** @type {import('svelte/store').Writable<any>} */
export const settingsSection = writable(null);
export const propertiesClose = writable(true);
export const scenePropertiesClose = writable(true);
export const lightPropertiesClose = writable(true);
export const flowGraphClose = writable(true);
export const objectListClose = writable(true);
export const chatHidden = writable('hidden');
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
export const peers = writable(null);
export const toggleExpand = writable(null);
export const closeMenu = writable(true);
export const specatorMode = writable(false);

// update the sidebar visibility
export function showSidebar(store) {
	// Configure Scene and Library TOGGLE: a second click closes them
	// (properties/lightProperties stay open-only — selection must never close them)
	if (store === 'scene' && !get(scenePropertiesClose)) {
		scenePropertiesClose.set(true);
		return;
	}
	if (store === 'library' && !get(libraryClose)) {
		libraryClose.set(true);
		return;
	}
	if (store != 'library') libraryClose.set(true);
	if (store != 'scene') scenePropertiesClose.set(true);
	if (store != 'lightProperties') lightPropertiesClose.set(true);
	if (store != 'properties') propertiesClose.set(true);

	// The delay adds cool effect
	setTimeout(() => {	
		if (store === 'library') libraryClose.set(false);
		if (store === 'scene') scenePropertiesClose.set(false);
		if (store === 'lightProperties') lightPropertiesClose.set(false);
		if (store === 'properties') propertiesClose.set(false);
		// if (store === null) {}
	}, 50);
  }

// Snapshot/restore of panel visibility, used when opening Settings or entering
// spectate mode. A single snapshot slot: hidePanels() while already hidden is a
// no-op, so nested calls (settings during spectate) don't clobber the snapshot.
/** @type {any} */
let panelSnapshot = null;

/** @param {string[]} keep - panel keys to leave untouched: 'menu' | 'library' | 'light' | 'sceneProps' | 'properties' | 'flow' | 'objectList' | 'chat' */
export function hidePanels(keep = []) {
	if (panelSnapshot) return;
	panelSnapshot = {
		menu: get(closeMenu),
		library: get(libraryClose),
		light: get(lightPropertiesClose),
		sceneProps: get(scenePropertiesClose),
		properties: get(propertiesClose),
		flow: get(flowGraphClose),
		objectList: get(objectListClose),
		chat: get(chatHidden)
	};
	if (!keep.includes('menu')) closeMenu.set(true);
	if (!keep.includes('library')) libraryClose.set(true);
	if (!keep.includes('light')) lightPropertiesClose.set(true);
	if (!keep.includes('sceneProps')) scenePropertiesClose.set(true);
	if (!keep.includes('properties')) propertiesClose.set(true);
	if (!keep.includes('flow')) flowGraphClose.set(true);
	if (!keep.includes('objectList')) objectListClose.set(true);
	if (!keep.includes('chat')) chatHidden.set('hidden');
}

export function restorePanels() {
	if (!panelSnapshot) return;
	closeMenu.set(panelSnapshot.menu);
	libraryClose.set(panelSnapshot.library);
	lightPropertiesClose.set(panelSnapshot.light);
	scenePropertiesClose.set(panelSnapshot.sceneProps);
	propertiesClose.set(panelSnapshot.properties);
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

/**
 * Plain string = 3s info toast. Pass `actions` ([{label, action}]) for a
 * sticky decision toast (15s) with buttons.
 * @param {string} message @param {{label: string, action: () => void}[]=} actions
 */
export function showToast(message, actions) {
  toastStore.update((toast) => [...toast, actions ? { text: message, actions } : message]);
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
			type: newMessage.type
		}
	]);
}
