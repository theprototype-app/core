// Module SDK — api.game — the game shell (rounds, vars, levels, settings, help, restart, menu).
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { coalescedSubscribe } from '../coalesce';
import {
	registerGameSetting,
	gameSettingValue,
	setGameSetting,
	gameSettingValues
} from '../gameSettings';
import {
	setGameLevels,
	setGameHelp,
	onGameRestart,
	openShellMenu,
	closeShellMenu,
	shellMenu,
	markShellGame
} from '../gameShell';
import { roundCutoff, roundUnderway, gameVar, setGameVar, gameState } from '../gameState';
import { get } from 'svelte/store';
import { flowRuntimeRef } from './refs.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkGame(ctx) {
	const { moduleId, onDispose } = ctx;
	return {
		/**
		 * R3a: THE GAME SHELL, read-mostly. The round reads are what `perRound` content
		 * gates on; the variable pair is the shared scoreboard (the game singleton — writes
		 * replicate latest-wins, and an `add` computed on every peer from one replicated
		 * stamp is the standing shared-scope semantic). Per-player numbers live in
		 * `api.peerVars` instead.
		 */
		game: {
			/** The replicated round cutoff: null = shell unused, Infinity = menu/over, else
			 * the running round's start (epoch ms). @returns {number | null} */
			roundCutoff() {
				return roundCutoff();
			},
			/** Is a round underway (playing or paused)? @returns {boolean} */
			roundUnderway() {
				return roundUnderway();
			},
			/** Is THIS peer playing inside a running round? (`isPlaying() && roundUnderway()`
			 * — the gate recipe-driven effects act under.) @returns {boolean} */
			playActive() {
				return !!flowRuntimeRef?.gamePlayActive?.();
			},
			/** @param {string} name @param {number=} fallback @returns {number} */
			getVar(name, fallback = 0) {
				return gameVar(name, fallback);
			},
			/** Replicated latest-wins write to the shared game singleton.
			 * @param {string} name @param {number} value */
			setVar(name, value) {
				setGameVar(name, value);
			},
			/** R29 S2: `fn()` runs after the game singleton changes (state, round, a
			 * variable) — COALESCED, at most once per frame however many writes land, never per
			 * store tick; torn down with the module (or earlier, by calling what it returns).
			 * Read what you need inside it. @param {() => void} fn @returns {() => void} off */
			onChange(fn) {
				const off = coalescedSubscribe([gameState], fn);
				onDispose(off);
				return off;
			},
			/**
			 * 31 K3: this game's LEVELS in the shared pause menu (desktop + the VR panel).
			 * `list` = [{id, label, locked?, stars?}] (stars 0..5), `current` = the id you are
			 * on, `onPick(id)` = the player chose one (never called for a locked level). Call it
			 * again to update (a level unlocked, stars earned). Cleared with the module.
			 * @param {{list: {id: string, label: string, locked?: boolean, stars?: number}[], current?: string, onPick?: (id: string) => void}} spec
			 * @returns {(() => void) | null} off, or null when the list is empty
			 */
			levels(spec) {
				const off = setGameLevels(spec, moduleId);
				if (off) onDispose(off);
				return off;
			},
			/**
			 * 31 K3: a row of this game's own in the pause menu's Settings (under the core
			 * rows: music, sound effects, haptics, FPS, turning, vignette, quality). Persisted
			 * per game on this device. `type` 'toggle' | 'choice' (with `options`, optional
			 * `optionLabels`) | 'range' (`min`/`max`/`step`). `onChange(value)` hears a change.
			 * 33: a choice with `onLevels: true` is ALSO drawn as tabs above the Levels page's
			 * grid (desktop + VR) — a choice that decides which levels you see (Untangle's Board).
			 * @param {{id: string, label: string, type?: 'toggle'|'choice'|'range', options?: string[], optionLabels?: string[], min?: number, max?: number, step?: number, default: any, onLevels?: boolean, onChange?: (value: any) => void}} row
			 * @returns {(() => void) | null} off, or null when refused (a core id, a bad row)
			 */
			addSetting(row) {
				const off = registerGameSetting(row, moduleId);
				if (off) onDispose(off);
				return off;
			},
			/** 31 K3: the current value of a setting — one of yours, or a core row ('music',
			 * 'musicVolume', 'sfx', 'sfxVolume', 'haptics', 'showFps', 'turning', 'turnAngle',
			 * 'vignette', 'quality'), so a module playing its OWN audio can obey 'sfx'.
			 * @param {string} id */
			setting(id) {
				return gameSettingValue(id);
			},
			/** 31 K3: write one of YOUR rows (a module's own in-game toggle). Core rows belong
			 * to the player and are refused. @param {string} id @param {any} value */
			setSetting(id, value) {
				if (['music', 'musicVolume', 'sfx', 'sfxVolume', 'haptics', 'showFps', 'turning', 'turnAngle', 'vignette', 'quality'].includes(id)) return undefined;
				return setGameSetting(id, value);
			},
			/** 31 K3: `fn(values)` hears every settings change (coalesced per frame).
			 * @param {(values: Record<string, any>) => void} fn @returns {() => void} off */
			onSettingsChange(fn) {
				const off = coalescedSubscribe([gameSettingValues], () => fn({ ...get(gameSettingValues) }));
				onDispose(off);
				return off;
			},
			/** 31 K3: the How to play page — a string (lines split on \n) or an array of lines.
			 * @param {string | string[]} text @returns {() => void} off */
			setHelp(text) {
				const off = setGameHelp(text, moduleId);
				onDispose(off);
				return off;
			},
			/** 31 K3: the pause menu's Restart also runs `fn` (reset your board, respawn your
			 * enemies). @param {() => void} fn @returns {() => void} off */
			onRestart(fn) {
				const off = onGameRestart(fn, moduleId);
				onDispose(off);
				return off;
			},
			/** 31 K3: open / close the pause menu (a module's own Menu button), and ask
			 * whether it is open. Opening only works while playing a game. */
			openMenu() {
				markShellGame(true);
				onDispose(() => markShellGame(false));
				return openShellMenu('main');
			},
			closeMenu() {
				closeShellMenu();
			},
			menuOpen() {
				return get(shellMenu).open;
			}
		}
	};
}
