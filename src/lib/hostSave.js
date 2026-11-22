// Roadmap 56 C12/C13 — SAVE ON THE HOST, the one host-side path.
//
// A guest's edits live in the session's scene, which is the HOST's scene: saving it from the guest's
// own page would land the file in the guest's library (or, for an agent, in a headless browser nobody
// can reach). So "Save on host" (the session volume, C13) and the agent's `save_scene` (C12) both
// ask the host, and the host runs THIS function: a deliberate save of the open scene into the host's
// Explorer (`saveSceneAsLevel` — the same versioned save Ctrl+S makes, so Version history restores
// it). Editors only; a viewer is refused here, on the host, whatever the asker's UI showed.
//
// Dynamic imports only: `levels` is in the history family and this module is reached from the peer
// dispatcher lazily.

import { get } from 'svelte/store';
import { sessionHost } from './connectionState';

/** The refusal for a request, or null to run it. Pure over its facts (the meshRelay shape).
 * @param {{hosting: boolean, role: string | null, private?: boolean}} facts */
export function hostSaveRefusal(facts) {
	if (!facts.hosting) return 'only the session host can save on the host';
	if (facts.role === 'viewer') return 'view-only peers cannot save on the host — Copy to my library instead';
	if (facts.private) return "the host's scene is private";
	return null;
}

/**
 * mcp-fix: an AI's save may name the open scene or a new one, never another scene it would write over (its newest
 * version would become this scene, for everyone). Pure.
 * @param {string} name @param {string|null|undefined} openName @param {string[]} names the scenes in the library
 * @returns {string|null} the refusal, or null to go on
 */
export function agentSaveNameRefusal(name, openName, names) {
	const key = (/** @type {unknown} */ n) => String(n ?? '').trim().toLowerCase();
	if (key(name) === key(openName) || !names.some((n) => key(n) === key(name))) return null;
	return `a different scene is already called "${name}": pick another name, or ask the person to open that scene first`;
}

/**
 * Save the open scene on THIS machine because a peer (or an agent) asked. Resolves what was saved.
 * @param {{name?: string, folder?: string}} [args] `name` defaults to the open scene's; `folder` is a
 *   Library folder id or name (absent = the Library root)
 * @param {{by?: string, role?: string | null, remote?: boolean, agent?: boolean}} [ctx] who asked, and the role the HOST sees for
 *   them; `remote` = a peer pressed Save on host, which saves the open scene and leaves its older versions alone; `agent` = an AI asked: it keeps older versions too and may not take another scene's name
 * @returns {Promise<{ok: boolean, name?: string, file?: string, hash?: string, error?: string}>}
 */
export async function saveSceneOnHost(args = {}, ctx = {}) {
	const [{ currentLevel, saveSceneAsLevel }, explorer, { showToast }] = await Promise.all([
		import('./levels'),
		import('./explorer'),
		import('../stores/appStore')
	]);
	/** @type {any} */
	const at = get(currentLevel);
	const refusal = hostSaveRefusal({ hosting: !get(sessionHost), role: ctx.role ?? null, private: at?.private === true });
	if (refusal) return { ok: false, error: refusal };
	const name = (ctx.remote ? '' : String(args.name ?? '').trim().slice(0, 120)) || String(at?.name ?? '').trim() || 'Scene';
	if (ctx.agent) {
		const { levelItems } = await import('./levels');
		const taken = agentSaveNameRefusal(name, at?.name, levelItems().map((/** @type {any} */ i) => String(i.name ?? '').replace(/\.tpscene$/i, '')));
		if (taken) return { ok: false, error: taken };
	}
	if (ctx.remote && at?.name) {
		const { sceneAtRisk } = await import('./sceneOpenGuard');
		if (!sceneAtRisk()) return { ok: true, name, file: at.name, hash: at.hash };
	}
	let folderId = null;
	const want = String(args.folder ?? '').trim();
	if (want) {
		const folders = get(explorer.explorerFolders);
		folderId = (folders.find((f) => f.id === want) ?? folders.find((f) => f.name === want))?.id ?? null;
	}
	const saved = await saveSceneAsLevel(name, folderId, ctx.remote ? { prune: false, ...(at?.name ? {} : { consent: false }) } : ctx.agent ? { prune: false } : {});
	if (!saved) return { ok: false, error: 'the save failed on the host' };
	showToast((ctx.by ? ctx.by + ' saved "' : 'Saved "') + name + '" here' + (ctx.by ? ' (Save on host)' : ''));
	return { ok: true, name, file: saved.name, hash: saved.hash };
}
