// Module SDK — sidebar menu buttons, toolboxes and VR radial-menu entries.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { modulesOpen } from '../../stores/appStore';
import {
	registerModuleToolbox,
	unregisterModuleToolbox,
	openModuleToolbox,
	closeModuleToolbox,
	toggleModuleToolbox,
	isToolboxOpen
} from '../moduleToolboxes';
import { moduleMenuItems } from './registries.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkUi(ctx) {
	const { moduleId, onDispose } = ctx;
	return {
		/** Adds a button to the sidebar "Modules" section @param {string} label @param {() => void} action */
		registerMenu(label, action) {
			const item = { moduleId, label, action };
			moduleMenuItems.update((list) => [...list, item]);
			onDispose(() => moduleMenuItems.update((list) => list.filter((entry) => entry !== item)), 'menu');
		},
		/**
		 * A5: a real UI surface — a floating TOOLBOX on the app's own shared shell.
		 *
		 * Before this, module controls could only live behind `registerMenu`: two clicks
		 * deep inside the Modules MODAL, which then has to be CLOSED before the module's
		 * own overlay is usable. So modules hand-rolled fixed overlays at z-indexes they
		 * do not own. Write plain DOM into the node `mount` receives and you inherit
		 * dragWindow position persistence, focusStack z-banding, the <=640px bottom sheet
		 * and the whole `.tbx-*` CSS contract (`.tbx-label`, `.tbx-row`, `.tbx-btn`,
		 * `.tbx-primary`, `.tbx-check`, …) with no CSS of your own.
		 *
		 * `mount` returns its cleanup, and re-registering re-runs it, so 17-A2's dev-mode
		 * live reload rebuilds the contents in place.
		 *
		 * The user opens it from the sidebar's Modules section AND the viewport menu
		 * (one builder, two hosts), plus `shortcut` if you name one — which also lists it
		 * in Settings > Shortcuts. It is CLOSED at first: a palette that appears
		 * uninvited is the thing registerMenu was avoiding.
		 *
		 * LOCAL, always: a toolbox is this viewer's window. Nothing about it replicates
		 * or is saved with the scene, so what it CHANGES must still go through the
		 * replicated paths (api.send / api.create / api.physics.set).
		 *
		 * `playMode: true` keeps it visible in Play mode (host settings for a game);
		 * the default hides it, because a tool palette over a running game is in the way.
		 *
		 * `sidebar: false` leaves it OUT of the burger menu's Modules section and keeps
		 * its viewport-menu row — for a window that belongs to a workflow rather than to
		 * the app's permanent chrome. Pair it with a `registerMenu` button (which renders
		 * on your card in the Modules manager, beside Update/Remove) and
		 * `api.openToolbox(id)`, so the way in is where the module already is.
		 * @param {{id: string, title: string, key?: string, width?: number, minW?: number,
		 *   defaultRect?: {left?: number, top?: number, right?: number, bottom?: number},
		 *   mount: (el: HTMLElement) => (() => void) | void,
		 *   onOpen?: () => void, onClose?: () => void,
		 *   playMode?: boolean, shortcut?: string, sidebar?: boolean}} box
		 * @returns {string} the namespaced toolbox id (open/close it with this)
		 */
		registerToolbox(box) {
			const id = registerModuleToolbox({ ...box, moduleId });
			// hoisted: the `if` narrowing does not reach inside the closure below
			const keys = box.shortcut;
			// force-close + unregister, so disable / update / dev-reload never leave a
			// window on screen backed by a mount fn that no longer exists. KEYED: a
			// re-register under the same id replaces the box, so the older undo must not run
			// (it would close the new one)
			onDispose(() => unregisterModuleToolbox(id), 'toolbox', { key: 'toolbox:' + id });
			if (keys) {
				// T2: the shortcut carries its OWN id so teardown drops exactly it (it was
				// never removed before — a reload listed it twice, a removal kept it)
				const shortcutId = 'module:' + moduleId + ':toolbox:' + id;
				let disposed = false;
				onDispose(
					() => {
						disposed = true;
						import('../shortcuts').then((m) => m.unregisterShortcut(shortcutId));
					},
					'shortcut',
					{ key: 'shortcut:' + shortcutId }
				);
				// dynamic: shortcuts' subtree reaches history, the TDZ cycle family
				import('../shortcuts').then((m) => {
					if (disposed) return;
					m.registerShortcut({
						id: shortcutId,
						keys,
						group: 'Modules',
						label: box.title,
						action: () => import('../moduleToolboxes').then((t) => t.toggleModuleToolbox(id))
					});
				});
			}
			return id;
		},
		/**
		 * R3a follow-up: OPEN one of your own toolboxes. `registerToolbox` has always
		 * returned its id documented as "open/close it with this" — and there was nothing
		 * to open it with, so the promise was unkeepable (the `api.hud.rows` family: a
		 * surface whose own docs claim an API that does not exist). These are that half.
		 *
		 * `openToolbox` also DISMISSES the Modules manager when it is open, because the
		 * manager is the one piece of chrome that can cover a toolbox — a button on your
		 * module's card that opens a window behind the dialog it was clicked in is the
		 * exact complaint `registerToolbox` was built to answer. It is a no-op when the
		 * manager is closed, so nothing else changes.
		 * @param {string} id the id `registerToolbox` returned
		 */
		openToolbox(id) {
			modulesOpen.set(false);
			return openModuleToolbox(id);
		},
		/** @param {string} id */
		closeToolbox(id) {
			return closeModuleToolbox(id);
		},
		/** Open it if closed, close it if open — what a menu row or a card button wants.
		 * @param {string} id */
		toggleToolbox(id) {
			if (!isToolboxOpen(id)) modulesOpen.set(false);
			return toggleModuleToolbox(id);
		},
		/**
		 * Add a sector to the VR radial menu (74). group 'root' extends the base
		 * ring; any other group name becomes a sub-ring reachable via a nav
		 * entry ({ring: '<group>'}).
		 * @param {{id: string, group?: string, label: string, order?: number,
		 *   ring?: string, action?: () => void, active?: () => boolean,
		 *   color?: string, closes?: boolean}} entry
		 */
		registerVRMenuEntry(entry) {
			// dynamic import: a static edge here closes a module cycle back into
			// history via materialsHandler (TDZ crash at boot)
			const id = moduleId + ':' + entry.id;
			import('../vrRadialMenu').then((menu) => menu.registerVRMenuEntry({ ...entry, id }));
			// same-module import promises resolve in .then order, so this always
			// runs after the registration even when teardown fires immediately
			onDispose(
				() => import('../vrRadialMenu').then((menu) => menu.unregisterVRMenuEntry(id, entry.group ?? 'root')),
				'vrMenu',
				{ key: 'vrMenu:' + id }
			);
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkUi.surface = {
	registerMenu: 'registers',
	registerToolbox: 'registers',
	openToolbox: 'action',
	closeToolbox: 'action',
	toggleToolbox: 'action',
	registerVRMenuEntry: 'registers'
};
