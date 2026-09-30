// 31 (K3) — THE GAME SHELL'S WIRING. gameShell.js and gameSettings.js are leaves; this is
// the one module that knows the heavy pieces the menu reaches (play mode, the game shell's
// reset, the spawn, the XR session, the Games tab, the quality governor, the audio buses)
// and hands them over as SEAMS. Started once from App.svelte's onMount.
//
// Everything that reaches the history-cycle family (levels, vrControls, gamePresence) is a
// DYNAMIC import, so importing this from App adds no static edge into it.
import { get } from 'svelte/store';
import { showToast, templatesModalOpen, templatesModalTab } from '../stores/appStore.js';
import { globalRenderer, isLocked, isVRMode, editorMode } from '../stores/sceneStore';
import { registerShellSeams, closeShellMenu, gameDescription, shellMenu } from './gameShell';
import { gameSettingValues, gameId, sfxLevel, musicLevel, noteSceneLevelName, slugGameId } from './gameSettings';
import { gameFeelOn } from './gameFeel';
import { setBusLevel } from './audioEngine';
import { exitPlay, embedMode } from './playMode';
import { stopGameMusic } from './gameMusic';
import { spawnDesktopPlayer, desktopSpawn, spawnEyePose } from './playSpawn';
import { games } from './sceneTemplates';
import { applyGameQuality } from './qualityGovernor';

/** @type {(() => void)[]} */
let disposers = [];

/** the level each quality preset pins (null = the governor decides) @type {Record<string, number | null>} */
export const QUALITY_PRESET_LEVELS = { auto: null, high: 0, medium: 3, low: 7 };

/** Install the seams + the live settings. Idempotent. */
export function startGameShell() {
	if (disposers.length) return;
	registerShellSeams({
		reset: () => {
			try {
				// the shell's own rule: host / alone / admin, else "carry on as it is"
				const mod = /** @type {any} */ (gamePresenceRef);
				return mod ? mod.requestResetGame() : { ok: true };
			} catch {
				return { ok: true };
			}
		},
		respawn: () => {
			if (get(isVRMode)) {
				vrControlsRef?.spawnPlayer?.();
				return;
			}
			const desk = desktopSpawn();
			if (!desk) return;
			if (get(isLocked) === true) spawnDesktopPlayer(desk);
			else if (get(editorMode) === 'interact') {
				const { eye, lookAt } = spawnEyePose(desk);
				objectActionsRef?.flyTo?.(eye, lookAt);
			}
		},
		exitPlay: () => exitPlay(),
		stopMusic: () => stopGameMusic(),
		endXR: () => {
			const session = /** @type {any} */ (get(globalRenderer))?.xr?.getSession?.();
			if (!session) return false;
			session.end?.().catch?.(() => {});
			return true;
		},
		openGames: () => {
			// an EMBED has no app menu to go to: leaving play puts its own ▶ back
			if (get(embedMode)) return;
			templatesModalTab.set('games');
			templatesModalOpen.set(true);
		},
		toast: (m) => showToast(m)
	});
	// primed dynamic imports — history-family modules, never a static edge from here
	import('./gamePresence').then((m) => (gamePresenceRef = m)).catch(() => {});
	import('./vrControls').then((m) => (vrControlsRef = m)).catch(() => {});
	import('./objectActions').then((m) => (objectActionsRef = m)).catch(() => {});
	import('./levels')
		.then((m) => {
			if (!disposers.length) return;
			disposers.push(m.currentLevel.subscribe((level) => queueMicrotask(() => noteSceneLevelName(/** @type {any} */ (level)?.name ?? null))));
		})
		.catch(() => {});

	// the per-game Music / Sound effects levels land on the audio BUSES, so every source on
	// them obeys (game sounds, flow sound nodes and pings on sfx; game music and the scene's
	// own track on music) without each one learning about games
	disposers.push(
		gameSettingValues.subscribe(() => {
			setBusLevel('sfx', sfxLevel());
			setBusLevel('music', musicLevel());
		})
	);
	// the Quality preset: pinned while PLAYING this game, released otherwise
	const applyQuality = () => {
		const preset = String(get(gameSettingValues).quality ?? 'auto');
		const level = get(gameFeelOn) ? (QUALITY_PRESET_LEVELS[preset] ?? null) : null;
		try {
			applyGameQuality(level, preset);
		} catch {
			/* the governor failing must never take the menu down */
		}
	};
	disposers.push(gameSettingValues.subscribe(applyQuality));
	disposers.push(gameFeelOn.subscribe(applyQuality));
	// leaving the game closes its menu (it is play-time chrome)
	disposers.push(
		gameFeelOn.subscribe((on) => {
			if (!on && get(shellMenu).open) queueMicrotask(() => closeShellMenu());
		})
	);
	// the game's own words for How to play, from the Games-tab index when it is loaded
	const describe = () => {
		const gid = get(gameId);
		const entry = get(games).find((/** @type {any} */ e) => e.slug === gid || slugGameId(e.title) === gid);
		gameDescription.set(entry ? { title: String(entry.title), description: String(entry.description ?? '') } : null);
	};
	disposers.push(gameId.subscribe(describe));
	disposers.push(games.subscribe(describe));
}

/** @type {any} */ let gamePresenceRef = null;
/** @type {any} */ let vrControlsRef = null;
/** @type {any} */ let objectActionsRef = null;

/** Test seam. */
export function stopGameShell() {
	for (const d of disposers) d();
	disposers = [];
}
