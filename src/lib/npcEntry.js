// 61-nav (roadmap 61 G10) — "Make this an enemy…": the object-menu door into the `navigation`
// module's sheet, and the agent tools' way to the same recipe.
//
// The sheet and the recipe live in the INSTALLABLE module (modules repo `navigation`), which
// registers them through `api.registerObjectAction({id: 'enemy', open, apply})`. Core keeps only
// the door: the row is listed whether or not the module is installed, and with the module absent
// it offers to install it from the module gallery (the same `installUrl(galleryInstallUrl(...))`
// path the Browse tab and a scene's "This scene uses modules" ask take), then opens the sheet.
// Only scenes that use NPCs pay for the navigation download.

import { get } from 'svelte/store';
import { moduleObjectActions, objectActionByKey } from './moduleWorldItems.js';
import { showToast } from '../stores/appStore';

export const NAV_MODULE_ID = 'navigation';
export const ENEMY_ACTION_KEY = NAV_MODULE_ID + ':enemy';

/** the module's registered action, or null */
export function enemyAction() {
	return objectActionByKey(get(moduleObjectActions), ENEMY_ACTION_KEY);
}

/** wait (bounded) for the module to register its action after an install @param {number} ms */
function waitForAction(ms) {
	return new Promise((resolve) => {
		const found = enemyAction();
		if (found) return resolve(found);
		/** @type {() => void} */
		let off = () => {};
		const timer = setTimeout(() => {
			off();
			resolve(enemyAction());
		}, ms);
		off = moduleObjectActions.subscribe(() => {
			const a = enemyAction();
			if (!a) return;
			clearTimeout(timer);
			queueMicrotask(() => off());
			resolve(a);
		});
	});
}

/**
 * Make sure the navigation module is loaded: already registered → its action; installed but
 * switched off → enabled; missing → installed from the gallery (asked first unless `ask: false`).
 * @param {{ask?: boolean}} [opts]
 * @returns {Promise<{action: any} | {error: string}>}
 */
export async function ensureNavigationModule(opts = {}) {
	const ready = enemyAction();
	if (ready) return { action: ready };
	const { userModules } = await import('./userModules');
	const record = get(userModules).find((/** @type {any} */ r) => r.id === NAV_MODULE_ID);
	if (record) {
		const { enableRequired } = await import('./sessions');
		await enableRequired([{ id: NAV_MODULE_ID }], { quiet: true });
		const a = await waitForAction(8000);
		return a
			? { action: a }
			: { error: 'The Navigation module is installed but did not start — reload and try again.' };
	}
	if (opts.ask !== false) {
		const { showChoice } = await import('./confirmDialog');
		const answer = await showChoice({
			title: 'Make this an enemy',
			message:
				'Enemies walk with the Navigation module (path finding, sight and hearing). It is not installed yet.\n\n' +
				'Install it from the module gallery? Every player needs their own copy; a scene that uses it asks them.',
			choices: [{ value: 'install', label: 'Install Navigation' }]
		});
		if (answer !== 'install') return { error: 'cancelled' };
	}
	const { loadModuleGallery, galleryModules, galleryInstallUrl } = await import('./moduleGallery');
	await loadModuleGallery();
	const found = get(galleryModules).find((/** @type {any} */ e) => e.id === NAV_MODULE_ID);
	if (!found)
		return {
			error:
				'The Navigation module is not in the module gallery yet (Modules ▸ User ▸ Install from zip works).'
		};
	const { installModuleJob } = await import('./moduleInstallJobs');
	const ok = await installModuleJob(NAV_MODULE_ID, galleryInstallUrl(found));
	if (!ok)
		return {
			error: 'Could not install the Navigation module — check Modules ▸ Browse for the reason.'
		};
	const a = await waitForAction(10000);
	return a
		? { action: a }
		: { error: 'The Navigation module installed but did not register its sheet.' };
}

/** the object-menu row's action: open the module's sheet for `uuid` (installing it first if asked) @param {string} uuid */
export async function openMakeEnemy(uuid) {
	const got = await ensureNavigationModule();
	if ('error' in got) {
		if (got.error !== 'cancelled') showToast(got.error);
		return false;
	}
	got.action.open(uuid);
	return true;
}
