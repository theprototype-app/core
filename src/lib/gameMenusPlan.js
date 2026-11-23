// 92 (GC1 / GC2 / GC5) — THE MENUS' EDIT AND PLAY RULES that only the lazy parts need (the panel, the
// connector, the title screen, the menus runtime): kept OUT of the boot leaves (gameMenusCore / gameMenus)
// on purpose, so a game that never uses them pays nothing at boot.
import { get } from 'svelte/store';
import { scenePhysicsState_, setScenePhysics } from './scenePhysics';
import { showToast } from '../stores/appStore';
import { MENUS_VERSION, normalizeGameMenus, menusNewer } from './gameMenusCore.js';

/** the authored config itself (null = none), for the panel and the connector */
export function gameMenusConfig() {
	return get(scenePhysicsState_)?.play?.menus ?? null;
}

/**
 * Change the authored menus (the panel, the connector): merged per block, replicated with the scene's
 * play block (setScenePhysics). `null` for a block removes it. @param {any} patch
 */
export function setGameMenus(patch) {
	if (menusNewer(gameMenusConfig())) {
		showToast('This game’s menus were made with a newer version of theprototype.app — update to change them here.');
		return null;
	}
	const next = patchGameMenus(gameMenusConfig(), patch);
	setScenePhysics({ play: { menus: next } });
	return next;
}

/**
 * Merge a patch into the authored config (the panel, the connector): blocks merge field by field,
 * `null` removes a block. Returns the normalized result (null = nothing authored any more).
 * @param {any} current @param {any} patch
 */
export function patchGameMenus(current, patch) {
	const base = current && typeof current === 'object' && !menusNewer(current) ? { ...current } : { v: MENUS_VERSION };
	const p = patch && typeof patch === 'object' ? patch : {};
	for (const key of ['title', 'pause', 'saves']) {
		if (!(key in p)) continue;
		if (p[key] === null || p[key] === false) delete base[key];
		else if (p[key] === true) base[key] = { ...(base[key] ?? {}), on: true };
		else if (typeof p[key] === 'object') base[key] = { ...(base[key] ?? {}), ...p[key] };
	}
	if ('autoAdmit' in p) {
		if (p.autoAdmit === true) base.autoAdmit = true;
		else delete base.autoAdmit;
	}
	return normalizeGameMenus(base);
}

/**
 * The title screen's buttons, in order. Continue only with a save to continue; Quit to editor only where
 * there is an editor to go back to (never in an export or a play link).
 * @param {{hasSave?: boolean, saves?: boolean, canQuit?: boolean}} o
 * @returns {{id: string, label: string}[]}
 */
export function titleItems(o = {}) {
	/** @type {{id: string, label: string}[]} */
	const items = [];
	if (o.hasSave) items.push({ id: 'continue', label: 'Continue' });
	items.push({ id: 'play', label: o.hasSave ? 'New game' : 'Play' });
	if (o.saves && o.hasSave) items.push({ id: 'load', label: 'Load game' });
	items.push({ id: 'settings', label: 'Settings' });
	if (o.canQuit) items.push({ id: 'quit', label: 'Quit to editor' });
	return items;
}

/**
 * Should opening the pause menu pause the game? Only when nobody ELSE is in Play (QUESTIONS Q1): the
 * world is one shared simulation, and the join card / another player's menu must never pause anyone.
 * @param {{rule: boolean, othersPlaying: number}} s
 */
export function pauseWanted(s) {
	return !!s.rule && (Number(s.othersPlaying) || 0) === 0;
}
