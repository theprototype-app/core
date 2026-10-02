// 33 (L2/L3/L4) — WHAT HAPPENS TO MODULES WHEN THE SCENE CHANGES.
//
// The user: "When opening another scene it should ask whether to keep all modules
// (otherwise for example untangle, if it were loaded, is kept) … the default is to ask …
// What should be done if I open a new project (I guess then modules should not be kept).
// Anyway, the user should know about the behavior." And: "when opened one game then
// another the new one stops working (opened waves, then towers — music from waves stays
// and the gun, but only objects from towers load)."
//
// A module is closer to a SCENE SCRIPT than to an editor plugin: Waves, Untangle, Football
// own a game's logic and draw into the world. So the modules a scene came with are the
// ones a switch asks about — those the scene being LEFT uses (its declared `modules` list
// and what its nodes/devices derive, moduleRequirements) and the scene being OPENED does
// not need. A user module no scene uses is a tool the person installed and is never asked
// about; a CORE module is part of the app.
//
// One setting (Settings ▸ Scene ▸ "When opening another scene"): ask (default) · keep ·
// unload. The answer UNLOADS a module the way the Modules manager's switch does: the live
// teardown journal (deactivateModule) and switched off (persisted). Reopening a scene that
// needs it goes through the existing "This scene uses modules" prompt, whose Enable now
// switches it back on live.
//
// Whatever the answer, sceneScope.js keeps a KEPT module's game registrations (levels,
// How to play, settings rows, Restart, music, spawn) out of the next game — this file wires
// what the scene USES into that leaf and drives its recompute.
//
// Not a leaf (moduleSDK, moduleRequirements, userModules), reached from sessions and levels
// by a dynamic import and from App.svelte at boot (`startSceneSwitch`).
import { writable, get } from 'svelte/store';
import { showToast, modulesOpen } from '../stores/appStore';
import { allNodes, flowGraphs } from '../stores/flowStore';
import { objectsGroup } from '../stores/sceneStore';
import { safeStorage } from './safeStorage';
import { showChoiceEx } from './confirmDialog';
export { showChoiceEx }; // 33 (L3): sceneTemplates reaches the dialog through its ONE import of this file
import { loadedModules, deactivateModule, disabledModules, moduleNodeGroups, loadedModulesChanged } from './moduleSDK';
import { moduleRequirements, sceneModules } from './moduleRequirements';
import { userModules } from './userModules';
import { registerSceneUsage, recomputeScope, settleScope, forgetScopeOf, leftBehindModules, sceneUsedModules, scopePending } from './sceneScope';

/* ------------------------------------------------------------------- the setting --- */

export const MODULES_ON_OPEN_KEY = 'scenes:modulesOnOpen';
/** @typedef {'ask' | 'keep' | 'unload'} ModulesOnOpen */
/** @param {any} v @returns {ModulesOnOpen} */
function asPolicy(v) {
	return v === 'keep' || v === 'unload' ? v : 'ask';
}
/** "When opening another scene": ask (default) · keep · unload. LOCAL (this device).
 * @type {import('svelte/store').Writable<ModulesOnOpen>} */
export const modulesOnOpen = writable(asPolicy(safeStorage.getItem(MODULES_ON_OPEN_KEY)));
modulesOnOpen.subscribe((v) => {
	if (v === 'ask') safeStorage.removeItem(MODULES_ON_OPEN_KEY);
	else safeStorage.setItem(MODULES_ON_OPEN_KEY, v);
});

/* ------------------------------------------------------------------- what counts --- */

/** A module this device installed itself (zip/URL) — the only kind a switch unloads. @param {string} id */
export function isUserModule(id) {
	return get(userModules).some((r) => r?.id === id);
}

/** the module ids a payload declares it needs @param {any} payload @returns {string[]} */
export function declaredModules(payload) {
	const list = Array.isArray(payload?.modules) ? payload.modules : [];
	return list.map((/** @type {any} */ m) => (typeof m === 'string' ? m : m?.id)).filter((/** @type {any} */ id) => typeof id === 'string' && id);
}

/** What the scene on screen uses: its declared list (the last load) ∪ what its nodes and
 * devices derive. @returns {string[]} */
function usedNow() {
	const ids = new Set(get(sceneModules).map((m) => m.id));
	for (const m of moduleRequirements()) ids.add(m.id);
	return [...ids];
}

/**
 * The modules a switch to a scene needing `incoming` would ask about: loaded USER modules
 * the scene on screen uses and the incoming one does not need.
 * @param {string[] | null} incoming the incoming scene's module ids (null = it needs none we know of)
 * @returns {{id: string, name: string}[]}
 */
export function switchCandidates(incoming) {
	const need = new Set(incoming ?? []);
	const used = new Set(sceneUsedModules());
	return loadedModules
		.filter((m) => used.has(m.id) && !need.has(m.id) && isUserModule(m.id))
		.map((m) => ({ id: m.id, name: m.name || m.id }));
}

/**
 * Every loaded user module the scene uses — what a NEW blank scene / a full Clear unloads.
 * @returns {{id: string, name: string}[]}
 */
export function sceneUserModules() {
	return switchCandidates([]);
}

/* ------------------------------------------------------------------- unloading --- */

const debug = { fullClears: 0, asks: 0, unloads: /** @type {string[][]} */ ([]), kept: /** @type {string[][]} */ ([]), lastAnswer: /** @type {string | null} */ (null) };

/** @param {{name: string}[]} mods */
function namesOf(mods) {
	const names = mods.map((m) => m.name);
	return names.length <= 1 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/**
 * Unload modules NOW: the live teardown journal (their music, menus, scene-root content,
 * input claims go with them) and switched off in the Modules manager, so a reload does not
 * bring them back. Says so, with the way back.
 * @param {{id: string, name: string}[]} mods @param {string} [why] the toast's lead
 * @returns {string[]} the ids unloaded
 */
export function unloadModules(mods, why = 'Unloaded') {
	const ids = mods.map((m) => m.id).filter((id) => loadedModules.some((m) => m.id === id));
	if (!ids.length) return [];
	disabledModules.update((list) => [...new Set([...list, ...ids])]);
	for (const id of ids) {
		deactivateModule(id);
		forgetScopeOf(id);
	}
	debug.unloads.push(ids);
	const gone = mods.filter((m) => ids.includes(m.id));
	showToast(why + ' ' + namesOf(gone) + ' — switch ' + (gone.length === 1 ? 'it' : 'them') + ' back on in Modules.', [
		{ label: 'Modules', action: () => modulesOpen.set(true) }
	]);
	return ids;
}

/**
 * L2 — THE ASK. Before a person's scene replace: which loaded modules does the scene being
 * left bring along that the incoming one does not need, and what does the person want done
 * with them. Resolves null for Cancel (the open does not happen), else a `run()` the caller
 * calls when the load really applies (a peer proposal applies later, or never).
 * @param {any} payload the incoming scene (its `modules` field is what it needs)
 * @param {{label?: string}} [opts]
 * @returns {Promise<{run: () => void, answer: 'keep' | 'unload' | 'none'} | null>}
 */
export async function prepareSceneSwitch(payload, opts = {}) {
	const mods = switchCandidates(declaredModules(payload));
	if (!mods.length) return { run: () => {}, answer: 'none' };
	const policy = get(modulesOnOpen);
	/** @type {'keep' | 'unload'} */
	let answer;
	let remembered = policy !== 'ask';
	if (policy === 'keep' || policy === 'unload') answer = policy;
	else {
		debug.asks++;
		const label = opts.label || payload?.name || 'this scene';
		const reply = await showChoiceEx({
			id: 'keep-modules',
			title: 'Keep the loaded modules?',
			message:
				'"' + label + '" does not use ' + (mods.length === 1 ? 'this module' : 'these modules') +
				' from the scene you are leaving. Unload stops ' + (mods.length === 1 ? 'it' : 'them') +
				' now (switch back on any time in Modules); Keep leaves ' + (mods.length === 1 ? 'it' : 'them') +
				' running.',
			items: mods.map((m) => m.name),
			checkbox: { label: 'Remember my choice', hint: 'Change it in Settings ▸ Scene ▸ When opening another scene.' },
			choices: [
				{ value: 'unload', label: 'Unload' },
				{ value: 'keep', label: 'Keep', color: 'alternative' }
			]
		});
		if (!reply) return null;
		answer = reply.value === 'keep' ? 'keep' : 'unload';
		if (reply.checked) {
			modulesOnOpen.set(answer);
			remembered = true;
		}
	}
	debug.lastAnswer = answer;
	return {
		answer,
		run: () => {
			if (answer === 'unload') unloadModules(mods, remembered && policy !== 'ask' ? 'Unloaded (your setting)' : 'Unloaded');
			else {
				debug.kept.push(mods.map((m) => m.id));
				// the user should know about the behaviour — say it whenever it was not asked
				if (policy === 'keep')
					showToast('Kept ' + namesOf(mods) + ' loaded (your setting: Settings ▸ Scene).');
			}
		}
	};
}

/* ------------------------------------------------------------- L3: Clear scene --- */

/**
 * What a scene holds BESIDE its objects — the "game setup" an objects-only Clear leaves
 * standing (the user: "after hitting clear scene in an opened game I still see the Menu
 * button and can play — clear scene does not really clear"). Each part is the reader the
 * save already uses (null = default), so "is there a setup" is the same question a save
 * asks. Read through PRIMED imports (below): these are singleton modules sessions.js owns
 * the order of, and this file is reached FROM sessions — a static edge would be a new cycle.
 * @returns {string[]} human labels, in the order the dialog lists them
 */
export function sceneSetupParts() {
	/** @type {string[]} */
	const parts = [];
	const r = setupRefs;
	try {
		if (r.hud?.hudDocsSnapshot() || r.game?.gameStateSnapshot()) parts.push('game menu & HUD');
		if (r.phys?.scenePhysicsSnapshot()) parts.push('play & physics settings');
		if (r.mus?.musicSnapshot()) parts.push('music');
		if (r.env?.environmentSnapshot() || r.post?.scenePostSnapshot()) parts.push('sky & look');
	} catch {
		/* a part we could not read is a part we do not claim */
	}
	if (allNodes().length) parts.push('flow nodes');
	return parts;
}

/** the singleton modules sceneSetupParts reads — PRIMED dynamic imports (resolved at boot,
 * long before anyone presses Clear), so the click path is synchronous: one await per import
 * cost a frame each on a heavy game scene, and the modal took ~15 s to appear (measured).
 * @type {{hud?: any, game?: any, phys?: any, mus?: any, env?: any, post?: any}} */
const setupRefs = {};
if (typeof window !== 'undefined') {
	void Promise.all([
		import('./hudDocs'),
		import('./gameState'),
		import('./scenePhysics'),
		import('./sceneMusic'),
		import('./environment'),
		import('./scenePost')
	])
		.then(([hud, game, phys, mus, env, post]) => Object.assign(setupRefs, { hud, game, phys, mus, env, post }))
		.catch(() => {});
}

/**
 * CLEAR EVERYTHING: the scene's modules unloaded (this device), then an EMPTY scene applied
 * the way any load applies — replicated, so every peer's objects, flow, HUD, game state,
 * play block, music, sky and look reset together, through the one path that already knows
 * how to replace a world. No backup stash (an objects-only Clear never stashed one either;
 * the confirm is the guard), no "Session loaded" toast.
 * @param {{id: string, name: string}[]} [mods] the modules to unload (default: the scene's)
 * @param {string} [name] the empty scene's name
 */
export async function clearSceneEverything(mods = sceneUserModules(), name = 'Untitled') {
	if (mods.length) unloadModules(mods, 'Unloaded');
	const { applySession, emptySessionPayload } = await import('./sessions');
	await applySession(emptySessionPayload(name), { backup: false, workspace: false, quiet: true });
	debug.fullClears++;
}

/* ----------------------------------------------------------- scope (L4) wiring --- */

/** the incoming scene arrived: the scope judgement for this switch is final @param {any} payload */
export function sceneArrived(payload) {
	settleScope(declaredModules(payload));
}

let started = false;
/** @type {any} */
let timer = null;
function scheduleRecompute() {
	// nothing pending and nothing left behind: there is nothing to judge, so a pokeScene storm
	// costs nothing (moduleRequirements walks the whole tree)
	if (!get(leftBehindModules).size && !scopePending()) return;
	clearTimeout(timer);
	timer = setTimeout(() => recomputeScope(), 250);
}

/** Boot: register what the scene uses with the scope leaf and keep the judgement current. */
export function startSceneSwitch() {
	if (started) return;
	started = true;
	registerSceneUsage(usedNow);
	// a peer's replacement arrives as clear + objects + a nodes snapshot, with no
	// applySession on this side — the graphs and the tree changing are what judge it here
	flowGraphs.subscribe(scheduleRecompute);
	objectsGroup.subscribe(scheduleRecompute);
	moduleNodeGroups.subscribe(scheduleRecompute);
	sceneModules.subscribe(() => recomputeScope());
	// a module that (re)activates starts in scope
	let known = new Set(loadedModules.map((m) => m.id));
	loadedModulesChanged.subscribe(() => {
		const now = new Set(loadedModules.map((m) => m.id));
		for (const id of now) if (!known.has(id)) forgetScopeOf(id);
		known = now;
	});
}

/** the suites' view */
export function sceneSwitchDebug() {
	return {
		policy: get(modulesOnOpen),
		asks: debug.asks,
		unloads: debug.unloads.map((u) => [...u]),
		kept: debug.kept.map((k) => [...k]),
		lastAnswer: debug.lastAnswer,
		fullClears: debug.fullClears,
		used: sceneUsedModules(),
		leftBehind: [...get(leftBehindModules)],
		candidates: switchCandidates([]).map((m) => m.id),
		nodes: allNodes().length
	};
}
