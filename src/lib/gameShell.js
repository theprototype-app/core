// 31 (K3) — THE GAME SHELL: one pause menu in every game. The user, on a Quest: "Fix
// menu in all games, I should be able to enter main menu during game in any game", and
// "pick level does not show in vr".
//
// Every game (the seven Games-tab games, and any scene that is a game by the GameChip /
// VR rule: a state-bound HUD screen, a spawn, or a module publishing the play contract)
// gets the SAME menu, reachable during play:
//
//     Resume · Restart · Levels (when the game registered some) · Settings ·
//     How to play · Main menu
//
// on the desktop (Escape, or the corner Menu button — GameShellMenu.svelte) and in VR (the
// game panel's Menu button, the wrist card's Menu button and the controller's free X
// button — vrGamePanel draws the SAME pages from `shellMenuItems`). This module is the
// state and the actions; the two renderers are chrome.
//
// The menu is LOCAL and replicates nothing: opening it frees the pointer (HudLayer, the
// single writer of `playPointerFree`, folds `shellMenu.open` in) and does NOT pause the
// shared world — per-peer pause deliberately does not exist (21-E3: the world is a shared
// simulation; a game that wants a pause authors one). Restart goes through the game
// shell's own reset rule (`requestResetGame`: the host, or anyone alone) so a restart in a
// shared session cannot be one peer's unilateral act.
//
// A LEAF in the import sense: stores, gameState, hudDocs, playSettings. Everything
// heavier (playMode, physics, the XR session, the templates modal) is reached through a
// dynamic import or a registered seam, so moduleSDK, vrGamePanel and the Svelte chrome
// can all import this without closing a cycle into history.
import { writable, get } from 'svelte/store';
import { globalScene, isLocked, editorMode } from '../stores/sceneStore';
import { hudDocs, isGameHud, hudScreenOverride } from './hudDocs';
import { resolvePlaySettings, playPublishers } from './playSettings';
import { CORE_SETTINGS, gameSettingRows, gameSettingValues, setGameSetting, settingRow, currentGameId } from './gameSettings';
// 33 (L4): a registration belongs to its owner module, and counts only while that module
// belongs to the scene on screen (a leaf)
import { leftBehindModules, ownerInScope } from './sceneScope';
import { perfMark } from './perf/perfMarks.js';

/** @typedef {'main' | 'levels' | 'settings' | 'help'} ShellPage */

/** The menu: open, which page, and (33) the headset's page of the level grid — null = the page
 * holding the current level. LOCAL. @type {import('svelte/store').Writable<{open: boolean, page: ShellPage, levelPage?: number | null}>} */
export const shellMenu = writable({ open: false, page: /** @type {ShellPage} */ ('main'), levelPage: /** @type {number | null} */ (null) });

/** @param {ShellPage} [page] */
export function openShellMenu(page = 'main') {
	if (!shellMenuAvailable()) return false;
	shellMenu.set({ open: true, page: normalizePage(page), levelPage: null });
	debug.opens++;
	perfMark('menu', { page: normalizePage(page) }); // 34 PF: a profiler marker
	return true;
}
export function closeShellMenu() {
	if (get(shellMenu).open) shellMenu.set({ open: false, page: 'main', levelPage: null });
}
/** @returns {boolean} open after the toggle */
export function toggleShellMenu() {
	if (get(shellMenu).open) {
		closeShellMenu();
		return false;
	}
	return openShellMenu('main');
}
/** @param {ShellPage} page */
export function showShellPage(page) {
	shellMenu.update((m) => ({ ...m, page: normalizePage(page), levelPage: null }));
}
/** @param {any} page @returns {ShellPage} */
function normalizePage(page) {
	if (page === 'levels' && !get(gameLevels)) return 'main';
	return page === 'levels' || page === 'settings' || page === 'help' ? page : 'main';
}

/* ---------------------------------------------------------------- is it a game? --- */

/** A game by the GameChip / VR rule: a state-bound HUD screen, a spawn, or a module
 * publishing the play contract. */
export function shellSceneIsGame() {
	const scene = get(globalScene);
	if (isGameHud(get(hudDocs))) return true;
	if (!scene) return false;
	try {
		if (resolvePlaySettings(scene).spawn) return true;
		return playPublishers(scene).length > 0;
	} catch {
		return false;
	}
}

/** Is the player IN the game right now (desktop Play, or Interact — VR Play lands there)? */
export function shellPlaying() {
	return get(isLocked) === true || get(editorMode) === 'interact';
}

/** The menu is offered while playing a game (or while a game registered levels/settings
 * through the SDK — a module game with no HUD still counts). */
export function shellMenuAvailable() {
	return shellPlaying() && (shellSceneIsGame() || !!get(gameLevels) || forcedGame);
}
let forcedGame = false;
/** Test seam / a module that knows it is a game: count this scene as a game. @param {boolean} on */
export function markShellGame(on) {
	forcedGame = !!on;
}

/* ------------------------------------------------------------------- the levels --- */

/**
 * @typedef {{id: string, label: string, locked?: boolean, stars?: number}} ShellLevel
 * @typedef {{list: ShellLevel[], current: string | null, onPick: ((id: string) => void) | null, owner: string, reg: object}} ShellLevels
 */

/** What `api.game.levels` registered, or null — the newest registration whose owner is IN
 * SCOPE (33 L4: a kept module's levels do not appear in another game's menu).
 * @type {import('svelte/store').Writable<ShellLevels | null>} */
export const gameLevels = writable(null);

/** 33 (L4): every live levels registration, oldest first (a re-register moves to the end).
 * `gameLevels` is the newest one in scope. @type {ShellLevels[]} */
let levelRegs = [];
function publishLevels() {
	const shown = [...levelRegs].reverse().find((r) => ownerInScope(r.owner)) ?? null;
	if (get(gameLevels) !== shown) gameLevels.set(shown);
}

/**
 * Normalise a levels spec: every entry an id + label, `locked` a boolean, `stars` 0..5
 * (integers), at most 60 levels. Pure; exported for the suites.
 * @param {any} spec @returns {{list: ShellLevel[], current: string | null} | null}
 */
export function normalizeLevels(spec) {
	if (!spec || !Array.isArray(spec.list)) return null;
	/** @type {ShellLevel[]} */
	const list = [];
	const seen = new Set();
	for (const raw of spec.list.slice(0, 60)) {
		const id = String(raw?.id ?? '').trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		/** @type {ShellLevel} */
		const level = { id, label: String(raw?.label ?? id).slice(0, 48) };
		if (raw?.locked) level.locked = true;
		const stars = Number(raw?.stars);
		if (Number.isFinite(stars) && stars > 0) level.stars = Math.min(5, Math.round(stars));
		list.push(level);
	}
	if (!list.length) return null;
	const current = spec.current !== undefined && spec.current !== null && seen.has(String(spec.current)) ? String(spec.current) : null;
	return { list, current };
}

/**
 * Register (or update — re-callable) this game's levels. `onPick(id)` hears a pick from
 * either renderer; a locked level is shown and refuses. Returns off (removes only its own
 * registration), or null for a spec with no levels.
 * @param {any} spec @param {string} [owner]
 * @returns {(() => void) | null}
 */
export function setGameLevels(spec, owner = '') {
	const clean = normalizeLevels(spec);
	const who = String(owner || '');
	if (!clean) {
		// an empty list withdraws this owner's levels
		levelRegs = levelRegs.filter((r) => r.owner !== who);
		publishLevels();
		return null;
	}
	// the registration TOKEN, not the object: a pick re-publishes a copy with the new current
	const reg = {};
	/** @type {ShellLevels} */
	const next = { ...clean, onPick: typeof spec.onPick === 'function' ? spec.onPick : null, owner: who, reg };
	// one entry per owner: a re-call UPDATES (the newest), it never stacks
	levelRegs = [...levelRegs.filter((r) => r.owner !== who), next];
	publishLevels();
	return () => {
		levelRegs = levelRegs.filter((r) => r.reg !== reg);
		publishLevels();
	};
}

/**
 * The player picked a level. Returns true when the game heard it (a locked or unknown
 * level, or a game with no onPick, answers false and leaves the menu where it is).
 * @param {string} id
 */
export function pickGameLevel(id) {
	const levels = get(gameLevels);
	const level = levels?.list.find((l) => l.id === String(id));
	if (!levels || !level || level.locked || !levels.onPick) return false;
	try {
		levels.onPick(level.id);
	} catch {
		/* a game's callback throwing must not strand the player in the menu */
	}
	const picked = { ...levels, current: level.id };
	levelRegs = levelRegs.map((r) => (r.reg === levels.reg ? picked : r));
	gameLevels.set(picked);
	debug.picks.push(level.id);
	closeShellMenu();
	return true;
}

/* ------------------------------------------------------------------- how to play --- */

/** What a game says about itself (`api.game.setHelp`) — the newest registration in scope.
 * @type {import('svelte/store').Writable<{owner: string, lines: string[]} | null>} */
export const gameHelp = writable(null);

/** 33 (L4): every live help registration, oldest first @type {{owner: string, lines: string[]}[]} */
let helpRegs = [];
function publishHelp() {
	const shown = [...helpRegs].reverse().find((r) => ownerInScope(r.owner)) ?? null;
	if (get(gameHelp) !== shown) gameHelp.set(shown);
}

/** @param {any} text a string (lines split on \n) or an array of lines @param {string} [owner] */
export function setGameHelp(text, owner = '') {
	const lines = (Array.isArray(text) ? text : String(text ?? '').split('\n'))
		.map((l) => String(l).trim())
		.filter(Boolean)
		.slice(0, 16)
		.map((l) => l.slice(0, 160));
	const who = String(owner || '');
	const next = lines.length ? { owner: who, lines } : null;
	helpRegs = helpRegs.filter((r) => r.owner !== who);
	if (next) helpRegs.push(next);
	publishHelp();
	return () => {
		helpRegs = helpRegs.filter((r) => r !== next);
		publishHelp();
	};
}

/** The controls every game shares, by device. */
export const COMMON_CONTROLS = {
	desktop: ['Move: W A S D · look: mouse', 'Grab / use: click', 'Menu: Esc'],
	vr: ['Move: left stick or teleport (right stick up)', 'Grab: grip · use: trigger', 'Menu: X on the left controller, or Menu on the wrist']
};

/* --------------------------------------------------------------------- restart --- */

/** @type {Map<() => void, string>} hook -> owner module ('' = core / anonymous) */
const restartHooks = new Map();
/** A game's own restart (a module resetting its board). 33 (L4): a hook whose owner was
 * left behind by a scene switch does not run — a kept Waves must not reset itself when
 * Towers restarts. @param {() => void} fn @param {string} [owner] @returns {() => void} */
export function onGameRestart(fn, owner = '') {
	restartHooks.set(fn, String(owner || ''));
	return () => restartHooks.delete(fn);
}

/**
 * The actions the menu takes that need heavier modules (play mode, the game shell's reset,
 * the spawn, the XR session, the Games tab). REGISTERED by `startGameShell` (gameShellWire)
 * rather than imported, which keeps this module a leaf. @type {{
 *   reset?: () => {ok: boolean, reason?: string}, respawn?: () => void, exitPlay?: () => void, stopMusic?: () => void,
 *   endXR?: () => boolean, openGames?: () => void, toEditor?: () => void, toast?: (m: string) => void}}
 */
const seams = {};
/** @param {typeof seams} fns */
export function registerShellSeams(fns) {
	Object.assign(seams, fns);
}

/** Restart: the game's shell resets (host / alone), a module's own restart runs, the player
 * goes back to the spawn, and this peer's screen overrides clear. @returns {{ok: boolean, reason?: string}} */
export function restartGame() {
	const verdict = seams.reset ? seams.reset() : { ok: true };
	if (!verdict.ok) seams.toast?.((verdict.reason ?? 'The game cannot be restarted.') + ' Carrying on with the game as it is.');
	for (const [fn, owner] of restartHooks) {
		if (!ownerInScope(owner)) continue;
		try {
			fn();
		} catch {
			/* one game's hook must not stop the rest */
		}
	}
	hudScreenOverride.set({});
	seams.respawn?.();
	debug.restarts++;
	closeShellMenu();
	return verdict;
}

/**
 * MAIN MENU: leave the game cleanly to the app's main menu (the Games tab). Music stops,
 * the menu closes, play ends (the camera goes back to the editor's, which is the
 * camera-follows-isLocked effect), a headset session ends, and the Games tab opens.
 */
export function leaveToMainMenu() {
	closeShellMenu();
	seams.stopMusic?.();
	seams.endXR?.();
	if (get(editorMode) === 'interact') editorMode.set('edit');
	seams.exitPlay?.();
	seams.openGames?.();
	debug.mainMenus++;
}

/** Back to editing this scene (the desktop's quiet extra row; VR has its Edit mode button). */
export function leaveToEditor() {
	closeShellMenu();
	seams.exitPlay?.();
	if (get(editorMode) === 'interact') editorMode.set('edit');
	debug.toEditor++;
}

/* ------------------------------------------------------------------ the items ---- */

/**
 * The main page's rows, in order — BOTH renderers draw from this list, so the desktop and
 * the headset cannot disagree about what the menu offers. `vr` drops the desktop-only row.
 * @param {{vr?: boolean}} [opts] @returns {{id: string, label: string}[]}
 */
export function shellMenuItems(opts = {}) {
	/** @type {{id: string, label: string}[]} */
	const items = [
		{ id: 'resume', label: 'Resume' },
		{ id: 'restart', label: 'Restart' }
	];
	if (get(gameLevels)) items.push({ id: 'levels', label: 'Levels' });
	items.push({ id: 'settings', label: 'Settings' }, { id: 'help', label: 'How to play' }, { id: 'mainmenu', label: 'Main menu' });
	if (!opts.vr) items.push({ id: 'editor', label: 'Back to editor' });
	return items;
}

/** Run a main-page row by id (either renderer). @param {string} id */
export function runShellItem(id) {
	debug.items.push(id);
	switch (id) {
		case 'resume':
			closeShellMenu();
			return true;
		case 'restart':
			restartGame();
			return true;
		case 'levels':
		case 'settings':
		case 'help':
			showShellPage(/** @type {ShellPage} */ (id));
			return true;
		case 'back':
			showShellPage('main');
			return true;
		case 'mainmenu':
			leaveToMainMenu();
			return true;
		case 'editor':
			leaveToEditor();
			return true;
	}
	return false;
}

/* ------------------------------------------------------------- the page model ---- */

/** The game's own words from the Games-tab index (the wire fills it). @type {import('svelte/store').Writable<{title: string, description: string} | null>} */
export const gameDescription = writable(null);

/**
 * @typedef {{id: string, label: string, type: string, value: any, options?: string[], optionLabels?: string[],
 *   min?: number, max?: number, step?: number, vrOnly?: boolean, game?: boolean, display: string}} ShellSettingView
 */

/** A row's value as the menu shows it. @param {any} row @param {any} value */
export function settingDisplay(row, value) {
	if (row.type === 'toggle') return value ? 'On' : 'Off';
	if (row.type === 'choice') {
		const i = (row.options ?? []).indexOf(String(value));
		return String(row.optionLabels?.[i] ?? value);
	}
	const n = Number(value);
	return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * The settings page: the core rows (VR-only ones dropped on the desktop's `vr:false`
 * unless asked for) then the game's own rows, each with its value and display text.
 * @param {{vr?: boolean}} [opts] @returns {ShellSettingView[]}
 */
export function shellSettingViews(opts = {}) {
	const values = get(gameSettingValues);
	/** @type {ShellSettingView[]} */
	const out = [];
	for (const row of CORE_SETTINGS) {
		if (row.vrOnly && opts.vr === false) continue;
		out.push({ ...row, value: values[row.id], display: settingDisplay(row, values[row.id]) });
	}
	for (const row of get(gameSettingRows)) {
		const { onChange: _cb, owner: _o, ...plain } = row;
		out.push({ ...plain, game: true, value: values[row.id], display: settingDisplay(row, values[row.id]) });
	}
	return out;
}

/**
 * 33 (G3): the game's choices drawn as TABS above the Levels page (a setting registered with
 * `onLevels: true` — Untangle's Board: Globe / 2D board), with the option on now. Both
 * renderers read it. @returns {{id: string, label: string, options: {value: string, label: string}[], value: string}[]}
 */
export function shellLevelTabs() {
	const values = get(gameSettingValues);
	return get(gameSettingRows)
		.filter((row) => row.onLevels && row.type === 'choice')
		.map((row) => ({
			id: row.id,
			label: row.label,
			options: (row.options ?? []).map((o, i) => ({ value: o, label: String(row.optionLabels?.[i] ?? o) })),
			value: String(values[row.id] ?? row.default)
		}));
}

/** 33: the headset's level grid shows page `n` (0-based; clamped where it is drawn). @param {number} n */
export function showLevelPage(n) {
	shellMenu.update((m) => ({ ...m, levelPage: Math.max(0, Math.floor(Number(n) || 0)) }));
}

/**
 * Step a setting the way a controller does: a toggle flips, a choice walks (dir ±1,
 * wrapping), a range moves by its step (clamped). Returns the new value.
 * @param {string} id @param {number} [dir]
 */
export function stepGameSetting(id, dir = 1) {
	const row = settingRow(id);
	if (!row) return undefined;
	const value = get(gameSettingValues)[id] ?? row.default;
	if (row.type === 'toggle') return setGameSetting(id, !value);
	if (row.type === 'choice') {
		const options = row.options ?? [];
		const i = Math.max(0, options.indexOf(String(value)));
		return setGameSetting(id, options[(i + (dir < 0 ? -1 : 1) + options.length) % options.length]);
	}
	return setGameSetting(id, Number(value) + (dir < 0 ? -1 : 1) * Number(row.step || 1));
}

/** The title a page wears. @param {ShellPage} page */
export function shellPageTitle(page) {
	return page === 'levels' ? 'Levels' : page === 'settings' ? 'Settings' : page === 'help' ? 'How to play' : 'Paused';
}

/** The game's name for the menu's subtitle. */
export function shellGameName() {
	const d = get(gameDescription);
	if (d?.title) return d.title;
	const id = currentGameId();
	return id === 'untitled' ? 'Game' : id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The How-to-play lines: the game's own words, then the device's common controls. @param {{vr?: boolean}} [opts] */
export function shellHelpLines(opts = {}) {
	/** @type {string[]} */
	const lines = [];
	const own = get(gameHelp)?.lines ?? [];
	if (own.length) lines.push(...own);
	else if (get(gameDescription)?.description) lines.push(String(get(gameDescription)?.description));
	lines.push('', ...(opts.vr ? COMMON_CONTROLS.vr : COMMON_CONTROLS.desktop));
	return lines;
}

/**
 * A press on a VR shell hit id ('shell:item:<id>' / 'shell:level:<id>' /
 * 'shell:set:<id>:<prev|next>' / 'shell:back'). Returns true when something acted.
 * @param {string} hitId
 */
export function pressShellHit(hitId) {
	const parts = String(hitId).split(':');
	if (parts[0] !== 'shell') return false;
	if (parts[1] === 'item') return runShellItem(parts.slice(2).join(':'));
	if (parts[1] === 'back') return runShellItem('back');
	if (parts[1] === 'level') return pickGameLevel(parts.slice(2).join(':'));
	// 33: a tab above the grid (tab:<setting index>:<option index> of shellLevelTabs) and the
	// headset grid's page arrows (lvpage:<page>)
	if (parts[1] === 'tab') {
		const tab = shellLevelTabs()[Number(parts[2])];
		const option = tab?.options[Number(parts[3])];
		if (!tab || !option) return false;
		if (option.value !== tab.value) setGameSetting(tab.id, option.value);
		return true;
	}
	if (parts[1] === 'lvpage') {
		showLevelPage(Number(parts[2]));
		return true;
	}
	if (parts[1] === 'set') {
		const dir = parts[parts.length - 1] === 'prev' ? -1 : 1;
		const id = parts.slice(2, parts.length - 1).join(':');
		return stepGameSetting(id, dir) !== undefined;
	}
	return false;
}

/* ------------------------------------------------------------------- the rest ---- */

const debug = {
	opens: 0,
	restarts: 0,
	mainMenus: 0,
	toEditor: 0,
	/** @type {string[]} */ items: [],
	/** @type {string[]} */ picks: []
};

/** the suites' view */
export function gameShellDebug() {
	return {
		...debug,
		items: [...debug.items],
		picks: [...debug.picks],
		menu: { ...get(shellMenu) },
		available: shellMenuAvailable(),
		isGame: shellSceneIsGame(),
		// 34 R6: the lifecycle contract reads these (a module's hooks must go with it)
		restartHooks: restartHooks.size,
		forcedGame,
		levels: get(gameLevels) ? { list: get(gameLevels)?.list.map((l) => ({ ...l })), current: get(gameLevels)?.current } : null
	};
}

/** Test seam. */
export function resetGameShell() {
	closeShellMenu();
	levelRegs = [];
	helpRegs = [];
	gameLevels.set(null);
	gameHelp.set(null);
	restartHooks.clear();
	forcedGame = false;
	debug.opens = debug.restarts = debug.mainMenus = debug.toEditor = 0;
	debug.items = [];
	debug.picks = [];
}

// 33 (L4): a scene switch moves modules in or out of scope — re-pick what the menu shows.
// Declared at the END: the publishers read `levelRegs`/`helpRegs`, and a module-level
// subscribe runs its callback synchronously at evaluation (the TDZ rule).
leftBehindModules.subscribe(() => {
	publishLevels();
	publishHelp();
});
