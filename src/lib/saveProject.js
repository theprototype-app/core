// Roadmap 56 C13 — SAVE PROJECT WITH SEVERAL LIBRARIES OPEN (owner, addendum 2026-10-28f).
//
// A guest in a session has two libraries in front of it — its own and "<HOST>'s session" — and a
// mounted project is a third. "Save project" (the burger's Save with the Project format) and Ctrl+S
// must never save one into another, and must not make the person guess which one a press saves:
//
//   · one library open  → save it straight away, exactly as before (no dialog; the scene guard is
//     the only question that can appear);
//   · several           → Settings ▸ Save options ▸ "When several libraries are open" decides:
//     Ask (default) opens ONE dialog (every open library with a checkbox, the ACTIVE connection's
//     pre-checked, where each saves, the dirty-scene line, "Remember my choice"), "Save the active one"
//     and "Save all I can" save without asking.
//
// What "open" means for the count: my Library, every session volume, and a mounted project WITH
// UNSAVED CHANGES (a clean mount has nothing to save — counting it would put a dialog in front of
// every Ctrl+S of anyone who merely mounted something; it is still LISTED, disabled with the reason,
// whenever the dialog does appear). Each library saves through its own existing path: mine = the
// press's own save (the burger's format save, or Ctrl+S's scene save), a session = Save on host
// (sessionVolumes → hostSave, editors only), a mount = saveVolume. Each path already reports one
// result line, so N libraries saved = N lines.
//
// Reached by DYNAMIC import from the burger and the shortcut, so none of this is in the boot graph.

import { get } from 'svelte/store';
import { mountedVolumes, saveVolume } from './mountedVolumes';
import { sessionVolumes, saveOnHost, isSessionVolumeId } from './sessionVolumes';
import { sessionHost } from './connectionState';
import { saveOptions, setSaveOptions } from './saveOptions';
import { resolveSaveMany, saveDialogRows, sessionVolumeId } from './sessionVolumeCore';
import { saveManyDialog } from './saveManyState';
import { currentLevel } from './levels';
import { sceneAtRisk } from './sceneOpenGuard';

/** @typedef {import('./sessionVolumeCore').OpenLibrary} OpenLibrary */

/**
 * Every library this page has open, in the dialog's order (mine, sessions, mounts).
 * @param {{all?: boolean}} [opts] `all` lists clean mounts too (the dialog does; the count does not)
 * @returns {OpenLibrary[]}
 */
export function openLibraries(opts = {}) {
	const host = get(sessionHost);
	const sessions = get(sessionVolumes);
	const activeSession = host ? sessions.find((v) => v.id === sessionVolumeId(host)) ?? sessions[0] : null;
	/** @type {OpenLibrary[]} */
	const out = [{ id: 'library', kind: 'library', name: 'My Library', active: !activeSession, canSave: true }];
	for (const v of sessions)
		out.push({
			id: v.id,
			kind: 'session',
			name: v.name,
			active: v === activeSession,
			canSave: v.role !== 'viewer',
			...(v.role === 'viewer' ? { reason: "You're view-only in " + v.host + "'s session — use Copy to my library instead" } : {})
		});
	for (const m of get(mountedVolumes)) {
		const saveable = !!m.dirty && !m.missing;
		if (!saveable && !opts.all) continue;
		out.push({
			id: m.id,
			kind: 'mount',
			name: m.name,
			active: false,
			canSave: saveable,
			...(saveable ? {} : { reason: m.missing ? 'The saved project behind this mount is gone' : 'No unsaved changes' })
		});
	}
	return out;
}

/** The open scene's name when it has unsaved changes (the dialog's dirty-scene line), else null. */
function dirtySceneName() {
	/** @type {any} */
	const at = get(currentLevel);
	try {
		return at?.name && sceneAtRisk() ? String(at.name) : null;
	} catch {
		return null;
	}
}

/** the press's own save while the dialog is open @type {(() => any) | null} */
let pendingOwn = null;

/**
 * A Save project press (the burger, format Project) or Ctrl+S. `saveOwn` is what the press does for
 * MY Library — byte-identical to before this existed whenever only one library is open.
 * @param {'burger' | 'ctrls'} trigger @param {() => any} saveOwn
 * @returns {Promise<{dialog: boolean, saved: string[]}>}
 */
export async function saveProjectPressed(trigger, saveOwn) {
	const libs = openLibraries();
	const verdict = resolveSaveMany(get(saveOptions).saveMany, libs);
	if (verdict.dialog) {
		pendingOwn = saveOwn;
		saveManyDialog.set({ trigger, rows: saveDialogRows(openLibraries({ all: true })), scene: dirtySceneName() });
		return { dialog: true, saved: [] };
	}
	if (!verdict.save.length && libs.length > 1) {
		const { showToast } = await import('../stores/appStore');
		showToast('Nothing saved: the active library cannot be saved by you — Settings ▸ Save options decides what a Save does here');
	}
	await saveLibraries(verdict.save, saveOwn, {});
	return { dialog: false, saved: verdict.save };
}

/**
 * Save these libraries, each through its own path, never one into another.
 * @param {string[]} ids @param {(() => any) | null} saveOwn
 * @param {{sceneFirst?: boolean}} opts `sceneFirst`: save the open (dirty) scene into my Library
 *   before my Library's save (the dirty-scene line, burger route)
 */
export async function saveLibraries(ids, saveOwn, opts) {
	for (const id of ids) {
		if (id === 'library') {
			if (opts.sceneFirst) {
				/** @type {any} */
				const at = get(currentLevel);
				const { saveSceneAsLevel } = await import('./levels');
				if (at?.name) await saveSceneAsLevel(at.name, null);
			}
			await saveOwn?.();
		} else if (isSessionVolumeId(id)) await saveOnHost(id);
		else await saveVolume(id);
	}
}

/**
 * The dialog's Save. `remember` writes the setting when the choice IS one of its two answers
 * (only the active one ticked → "Save the active one"; every saveable one → "Save all I can").
 * @param {string[]} ids @param {{remember?: boolean, sceneFirst?: boolean}} [opts]
 * @returns {Promise<string | null>} the remembered setting, if any
 */
export async function confirmSaveMany(ids, opts = {}) {
	const state = get(saveManyDialog);
	saveManyDialog.set(null);
	const own = pendingOwn;
	pendingOwn = null;
	if (!state) return null;
	let remembered = null;
	if (opts.remember) {
		const saveable = state.rows.filter((r) => !r.disabled).map((r) => r.id);
		const active = state.rows.find((r) => r.active && !r.disabled)?.id;
		const same = (/** @type {string[]} */ a, /** @type {string[]} */ b) => a.length === b.length && a.every((x) => b.includes(x));
		if (active && same(ids, [active])) remembered = 'active';
		else if (same(ids, saveable)) remembered = 'all';
		if (remembered) setSaveOptions({ saveMany: /** @type {any} */ (remembered) });
		else {
			const { showToast } = await import('../stores/appStore');
			showToast('Not remembered — "Remember my choice" keeps "the active one" or "all I can"; pick one of those to remember it');
		}
	}
	await saveLibraries(ids, own, { sceneFirst: !!opts.sceneFirst && state.trigger === 'burger' });
	return remembered;
}

/** The dialog was cancelled: nothing is saved. */
export function cancelSaveMany() {
	pendingOwn = null;
	saveManyDialog.set(null);
}
