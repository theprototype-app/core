// Roadmap 104 C3 — `scene {list, open, new}`: the assistant opens the person's other scenes for them
// ("the assistant should be able to do it for me", the owner's note). A lazy chunk.
//
// THE UNSAVED-CHANGES RULE, which is the whole design:
//   · the request said what to do with them  -> `unsaved: "save" | "discard"`, no dialog for that choice.
//     "save" goes through the person's own save path (sceneOpenGuard's "Save and open": a version of a
//     project scene, else a save into the Library) and the answer names what was saved; "discard" is
//     honoured only when the person's words in this turn said so (the tool description says that).
//   · nothing said -> the person's own dialog, on their screen: Save and open / Open without saving / Cancel
//     (a needsConfirm + confirmId answer, the confirmGate shape) -> {opened, saved} or {cancelled}.
//   · hosting with others -> the dialog ALWAYS shows, whatever the request said ("3 other people are here").
//   · a guest -> refused: the session's world is the host's (Explorer's C13 rule, without its Leave route).
// The switch is the person's Explorer Open (`travelToLevel`, a local replace: the page, and so the
// connector, stays up); the answer tells the agent to read the scene again, and undo_last / checkpoints
// from before the switch end there (agentLogRecorder.sceneSwitched).

import { get } from 'svelte/store';
import { peers, showToastById } from '../../stores/appStore';
import { sessionHost } from '../connectionState';
import { isViewer } from '../objectPermissions';
import { askPerson, askKnown } from './personAsk.js';
import { createRateLimit, pathOfItem } from './filesCore.js';

/** switches a minute: a scene replace is the heaviest thing the tool can do */
export const SWITCHES_PER_MINUTE = 4;
const switches = createRateLimit(SWITCHES_PER_MINUTE);
const debug = { opened: 0, refused: 0, last: /** @type {any} */ (null) };

/** @param {string} msg @param {any} [extra] */
const fail = (msg, extra) => {
	debug.refused++;
	return { error: msg, ...(extra ?? {}) };
};

const others = () => {
	/** @type {any} */
	const p = get(peers);
	return p?.openedPeers?.size ?? 0;
};

/** the scenes in the person's Library, one row per scene name (the visible card) */
async function sceneRows() {
	const { explorerFolders, loadExplorer } = await import('../explorer');
	await loadExplorer();
	const { levelItems, levelSceneName, currentLevel } = await import('../levels');
	const at = /** @type {any} */ (get(currentLevel));
	const folders = /** @type {any[]} */ (get(explorerFolders));
	/** @type {Map<string, any>} */
	const byName = new Map();
	for (const item of levelItems()) {
		const name = levelSceneName(item.name);
		if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { name, id: item.id, hash: item.hash, path: pathOfItem(item, folders), open: !!at && (at.hash === item.hash || (at.name === name && !at.unsaved)) });
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** what is open now */
async function current() {
	const { currentLevel } = await import('../levels');
	const { sceneAtRisk } = await import('../sceneOpenGuard');
	const at = /** @type {any} */ (get(currentLevel));
	return { name: at?.name || null, hash: at?.hash || null, unsaved: sceneAtRisk(), ...(at?.private ? { private: true } : {}), ...(at?.unsaved ? { looseFile: true } : {}) };
}

/** the refusals every switch shares @returns {string | null} */
function switchRefusal() {
	if (isViewer()) return 'View only: the host gave the person view access, so the scene cannot be changed from here';
	if (get(sessionHost)) return 'only the host can change the scene here: the person is a guest in someone else\'s session. They can open their own scenes after leaving it (Disconnect).';
	return null;
}

/** 104-int: a recording, Film on the phone or a sequence shot would be cut by a scene switch */
async function viewBusy() {
	const { busyCamera } = await import('./showTool.js');
	const why = await busyCamera();
	return why ? why.replace(/: wait/, ', so the scene is not switched: wait') : '';
}

/** @param {any} args */
async function list(args) {
	const rows = await sceneRows();
	const now = await current();
	const page = Math.max(1, Math.floor(Number(args.page) || 1));
	const slice = rows.slice((page - 1) * 100, page * 100);
	return {
		current: now,
		scenes: slice,
		total: rows.length,
		...(rows.length > page * 100 ? { nextPage: page + 1 } : {}),
		...(get(sessionHost) ? { note: 'The person is a guest in someone else\'s session: only the host can change the scene.' } : {})
	};
}

/**
 * The switch itself, after every question is answered.
 * @param {{hash: string, name: string}} target @param {'save' | 'discard' | 'none'} unsaved @param {string} by
 */
async function doSwitch(target, unsaved, by) {
	const { currentLevel, publishCurrentIfChanged, saveSceneAsLevel, travelToLevel, levelSceneName } = await import('../levels');
	const { activeFolder } = await import('../explorer');
	const before = /** @type {any} */ (get(currentLevel));
	const here = before?.name || 'This scene';
	/** @type {string | null} */
	let saved = null;
	if (unsaved === 'save') {
		// the guard's own "Save and open", verbatim: a version of a project scene, else a Library save
		const published = await publishCurrentIfChanged({ force: true });
		if (published) saved = here;
		else {
			const item = await saveSceneAsLevel(here, get(activeFolder) ?? null);
			if (!item) return fail('the save did not go through, so nothing was opened (the scene on screen is as it was)');
			saved = levelSceneName(/** @type {any} */ (item).name);
		}
	}
	// 104-int (O5 review): "discard" is never a silent loss. The scene on screen goes into Sessions first, as the
	// "Backup before" stash an ordinary load writes, so the person can bring it back from Sessions.
	/** @type {string | null} */
	let kept = null;
	if (unsaved === 'discard') {
		try {
			const { saveSession } = await import('../sessions');
			const name = 'Backup before "' + target.name + '"';
			if (await saveSession(name, { listOnly: true })) kept = name;
		} catch {}
		if (!kept) return fail('the unsaved changes could not be kept in Sessions, so nothing was opened (the scene on screen is as it was)');
	}
	switches.note();
	const ok = await travelToLevel(target.hash, '', { private: false, askModules: false, freshGame: true });
	if (!ok) return fail('"' + target.name + '" could not be opened (its file may not be on this device yet)', saved ? { saved } : undefined);
	debug.opened++;
	debug.last = { opened: target.name, saved, at: Date.now() };
	try {
		const rec = await import('../agentLogRecorder.js');
		rec.sceneSwitched();
	} catch {}
	// Back = the person's own guarded open of the scene left behind (its saved version), when it has a name
	const backName = saved || (before?.name && !before?.unsaved ? String(before.name) : null);
	const words = (saved ? by + ' saved ' + saved + ' and opened ' + target.name : by + ' opened ' + target.name) + '.' + (kept ? ' Your unsaved changes are in Sessions as ' + kept + '.' : '');
	showToastById('scene-line', words, backName ? [{ label: 'Back', action: () => void backTo(backName) }] : []);
	return {
		opened: target.name,
		...(saved ? { saved } : {}),
		...(unsaved === 'discard' ? { discarded: here, keptInSessions: kept } : {}),
		note: 'The scene changed: call list_scene before editing (every uuid from before is gone). undo_last and checkpoints from before the switch end here.'
	};
}

/** the line's Back: the person's own guarded open of the scene they left @param {string} name */
async function backTo(name) {
	const { guardSceneReplace } = await import('../sceneOpenGuard');
	const { travelToScene } = await import('../levels');
	if (!(await guardSceneReplace(name))) return;
	await travelToScene(name);
}

/** @param {any} args */
async function resolveTarget(args) {
	const rows = await sceneRows();
	const want = String(args.name ?? args.path ?? '').trim().replace(/\.tpscene$/i, '');
	const id = String(args.id ?? '').trim();
	const hit = id ? rows.find((r) => r.id === id) : rows.find((r) => r.name.toLowerCase() === want.toLowerCase() || r.path.replace(/\.tpscene$/i, '').toLowerCase() === want.toLowerCase());
	if (hit) return hit;
	const near = rows.filter((r) => want && r.name.toLowerCase().includes(want.toLowerCase())).map((r) => r.name);
	return { error: 'no scene "' + (want || id) + '" in the person\'s Library' + (near.length ? ': did you mean ' + near.slice(0, 5).join(', ') + '?' : ' (scene {action: "list"} shows them)') };
}

/**
 * Open a scene (or a new one), with the unsaved-changes rule.
 * @param {any} args @param {string} by @param {() => Promise<{hash: string, name: string} | {error: string}>} target
 * @param {string} label what the person is told is coming
 */
async function guardedOpen(args, by, target, label) {
	const refused = switchRefusal();
	if (refused) return fail(refused, { refused: true });
	const busy = await viewBusy();
	if (busy) return fail(busy, { refused: true, busy: true });
	const wantUnsaved = args.unsaved === 'save' || args.unsaved === 'discard' ? args.unsaved : null;
	if (args.unsaved !== undefined && args.unsaved !== null && !wantUnsaved) return fail('unsaved: "save" or "discard" (or leave it out and the person is asked)');
	const wait = askKnown('scene', args.confirmId) ? 0 : switches.check();
	if (wait) return fail('a scene switch at a time: wait ' + wait + ' s', { retryAfter: wait });
	const now = await current();
	const crowd = others();
	if (!crowd && (!now.unsaved || wantUnsaved)) {
		const t = await target();
		if ('error' in t) return fail(t.error);
		if (now.hash && t.hash === now.hash) return { opened: t.name, already: true, note: 'That scene is already open.' };
		return doSwitch(t, now.unsaved ? /** @type {'save' | 'discard'} */ (wantUnsaved) : 'none', by);
	}
	// the person's own dialog. With others here it always shows, and the choice about unsaved work is theirs
	// on screen unless the request already made it.
	/** @type {{label: string, value: string, cancel?: boolean}[]} */
	const choices = now.unsaved
		? [
				{ label: 'Save and open', value: 'save' },
				{ label: 'Open without saving', value: 'discard' },
				{ label: 'Cancel', value: 'cancel', cancel: true }
			]
		: [
				{ label: 'Open', value: 'none' },
				{ label: 'Cancel', value: 'cancel', cancel: true }
			];
	const crowdWords = crowd ? ' ' + crowd + (crowd === 1 ? ' other person is' : ' other people are') + ' in this session: it opens for you, and they can join you there (Go to).' : '';
	const unsavedWords = now.unsaved ? ' "' + (now.name || 'The scene on screen') + '" has unsaved changes.' : '';
	if (args.confirmId === undefined) {
		// resolve the target before asking, so a wrong name never reaches the person's screen
		const probe = await target();
		if ('error' in probe) return fail(probe.error);
		if (now.hash && probe.hash === now.hash) return { opened: probe.name, already: true, note: 'That scene is already open.' };
	}
	return askPerson('scene', args, {
		summary: 'open ' + label,
		prompt: by + ' wants to open ' + label + '.' + unsavedWords + crowdWords,
		choices,
		apply: async (value) => {
			const t = await target();
			if ('error' in t) return fail(t.error);
			const how = now.unsaved ? /** @type {'save' | 'discard'} */ (value === 'save' ? 'save' : 'discard') : 'none';
			return doSwitch(t, how, by);
		}
	});
}

/**
 * @param {any} args @param {{by?: string}} [ctx]
 */
export async function sceneTool(args, ctx = {}) {
	const a = args && typeof args === 'object' ? args : {};
	const action = String(a.action ?? '');
	const by = String(ctx.by || 'The assistant');
	if (action === 'list') return list(a);
	if (action === 'open') {
		if (!a.name && !a.path && !a.id) return fail('open: name (a scene from scene {action: "list"})');
		let resolved = /** @type {any} */ (null);
		const target = async () => (resolved ??= await resolveTarget(a));
		const t = await target();
		return guardedOpen(a, by, target, 'error' in t ? 'a scene' : '"' + t.name + '"');
	}
	if (action === 'new') {
		const { sceneNameTaken, freeSceneName, newLevel, levelSceneName } = await import('../levels');
		const name = String(a.name ?? '').trim().replace(/\.tpscene$/i, '') || freeSceneName('New scene');
		if (!a.confirmId && sceneNameTaken(name)) return fail('there is already a scene called "' + name + '": open it with scene {action: "open"}, or pick another name (' + freeSceneName(name) + ' is free)');
		let made = /** @type {any} */ (null);
		const target = async () => {
			if (made) return made;
			const refused = switchRefusal();
			if (refused) return { error: refused };
			// checked again right before the file is made: a name taken while the person was being asked is refused
			if (sceneNameTaken(name)) return { error: 'there is already a scene called "' + name + '" (' + freeSceneName(name) + ' is free)' };
			const { activeFolder } = await import('../explorer');
			const item = await newLevel(name, get(activeFolder) ?? null);
			made = item ? { hash: /** @type {any} */ (item).hash, name: levelSceneName(/** @type {any} */ (item).name) } : { error: 'the new scene could not be made' };
			return made;
		};
		// the file is made only once the person said yes (or nothing needed asking): a No leaves no empty scene behind
		const refused = switchRefusal();
		if (refused) return fail(refused, { refused: true });
		const busy = await viewBusy();
		if (busy) return fail(busy, { refused: true, busy: true });
		const now = await current();
		const asks = others() > 0 || (now.unsaved && !(a.unsaved === 'save' || a.unsaved === 'discard'));
		if (asks)
			return askPerson('scene', a, {
				summary: 'a new scene "' + name + '"',
				prompt:
					by + ' wants to make a new scene "' + name + '" and open it.' +
					(now.unsaved ? ' "' + (now.name || 'The scene on screen') + '" has unsaved changes.' : '') +
					(others() ? ' ' + others() + (others() === 1 ? ' other person is' : ' other people are') + ' in this session: it opens for you.' : ''),
				choices: now.unsaved
					? [
							{ label: 'Save and open', value: 'save' },
							{ label: 'Open without saving', value: 'discard' },
							{ label: 'Cancel', value: 'cancel', cancel: true }
						]
					: [
							{ label: 'Make it', value: 'none' },
							{ label: 'Cancel', value: 'cancel', cancel: true }
						],
				apply: async (value) => {
					const t = await target();
					if ('error' in t) return fail(t.error);
					const r = await doSwitch(t, now.unsaved ? (value === 'save' ? 'save' : 'discard') : 'none', by);
					return 'error' in r ? r : { ...r, created: t.name };
				}
			});
		const wait = switches.check();
		if (wait) return fail('a scene switch at a time: wait ' + wait + ' s', { retryAfter: wait });
		const t = await target();
		if ('error' in t) return fail(t.error);
		const r = await doSwitch(t, now.unsaved ? a.unsaved : 'none', by);
		return 'error' in r ? r : { ...r, created: t.name };
	}
	return fail('action: list, open or new');
}

/** unit / e2e */
export function sceneToolResetForTest() {
	switches.reset();
}
export function sceneToolDebug() {
	return { ...debug };
}
