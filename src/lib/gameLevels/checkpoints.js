// 93 LP3 / LP5 — CHECKPOINTS AND SAVED PROGRESS, PER PLAYER. Stepping on a Checkpoint (or arriving through
// a portal) makes that spot THIS player's respawn point: a fall, a "Back to checkpoint" node or a reload puts
// them there. Nothing is sent — another player has their own checkpoint, by definition.
//
//   in the editor   the checkpoint lasts for the session (a reload starts the scene fresh: authoring)
//   in an export    it is SAVED on the player's device (save.js: versioned, upgraded, 256 KB cap) with the
//                   level and the kept state, and the game resumes there on the next visit; New game forgets
//   a checkpoint    belongs to its scene: after a hop to another scene the old one no longer applies
import { writable, get } from 'svelte/store';
import { kit } from '../kit/runtime.js';
import { gameState } from '../gameState';
import { safeStorage } from '../safeStorage.js';
import { exportConfig, exportMode } from '../export/exportBoot.js';
import { runtimeSpawn } from '../playSettings';
import { sceneLevelsTable } from './runtime.js';
import { captureKept, resetOwnKept } from './keep.js';
import { spawnOfObject, setPlayerSpawn, clearPlayerSpawn, respawnNow, LEVELS_SPAWN_OWNER } from './spawn.js';
import { SAVE_VERSION, saveKey, upgradeSave, encodeSave } from './save.js';

/** @typedef {{kind: 'checkpoint' | 'portal', name: string, scene: string, spawn: {position: number[], yaw: number} | null}} Point */
/** THIS player's last checkpoint (null = none: the level start applies) @type {import('svelte/store').Writable<Point | null>} */
export const checkpointPoint = writable(null);
/** the "Checkpoint" flash (LevelTransition shows it briefly) @type {import('svelte/store').Writable<{name: string, at: number} | null>} */
export const checkpointFlash = writable(null);
/** the last save that could not be written (its reason, for the author) @type {import('svelte/store').Writable<string>} */
export const saveProblem = writable('');

/** test seam: persist outside an export too */
let persistOverride = /** @type {boolean | null} */ (null);
const persisting = () => persistOverride ?? exportMode;

/** the game's save key: the export's permanent game id, else its bundle id, else the scene's name */
function gameId() {
	return exportConfig?.gameId || exportConfig?.id || 'scene';
}

/** the scene this player stands in (a primed levels.js; '' before it loaded) */
let levelsRef = /** @type {any} */ (null);
async function sceneNow() {
	levelsRef ??= await import('../levels.js');
	return /** @type {any} */ (get(levelsRef.currentLevel))?.name ?? '';
}

/** reached a Checkpoint object (play.js, the rising edge) @param {any} cp */
export async function reachCheckpoint(cp) {
	const name = String(cp?.name || cp?.uuid || '');
	const scene = await sceneNow();
	const prev = get(checkpointPoint);
	if (prev?.kind === 'checkpoint' && prev.name === name && prev.scene === scene) return false;
	const spawn = spawnOfObject(cp);
	setPlayerSpawn(spawn, { teleport: false });
	checkpointPoint.set({ kind: 'checkpoint', name, scene, spawn });
	if (cp?.userData?.checkpoint?.show !== false) checkpointFlash.set({ name: cp?.userData?.checkpoint?.label || 'Checkpoint', at: Date.now() });
	await saveProgress();
	return true;
}

/** came through a portal: where it landed this player counts as a checkpoint @param {any} target */
export async function notePortalPassed(target) {
	const spawn = /** @type {any} */ (get(runtimeSpawn));
	const scene = await sceneNow();
	checkpointPoint.set({
		kind: 'portal',
		name: String(target?.spawn ?? ''),
		scene,
		spawn: spawn?.owner === LEVELS_SPAWN_OWNER ? { position: [...spawn.position], yaw: spawn.yaw ?? 0 } : null
	});
	await saveProgress();
}

/** a level hop with no portal (a Next level node): the old scene's checkpoint no longer applies */
export function forgetCheckpoint() {
	checkpointPoint.set(null);
}

/** Back to checkpoint: THIS player, now. Falls back to the level start. */
export function respawnAtCheckpoint() {
	const point = get(checkpointPoint);
	if (point?.spawn) return setPlayerSpawn(point.spawn);
	return respawnNow();
}

/** the record saved for this player now */
export async function buildSave() {
	const table = sceneLevelsTable();
	const vars = get(gameState)?.vars ?? {};
	const score = kit.doc()?.slices?.score ?? null;
	const point = get(checkpointPoint);
	return {
		v: SAVE_VERSION,
		game: gameId(),
		level: kit.impls.levels?.current?.() ?? '',
		scene: await sceneNow(),
		point: point ? { kind: point.kind, name: point.name, spawn: point.spawn } : null,
		kept: captureKept(table, { vars, score }),
		at: Date.now()
	};
}

let warned = '';
/** write this player's progress (exports only, unless a test says otherwise) */
export async function saveProgress() {
	if (!persisting()) return { ok: false, skipped: true };
	const enc = encodeSave(await buildSave());
	if (!enc.ok) {
		saveProblem.set(enc.reason);
		if (warned !== enc.reason) console.warn('levels: ' + enc.reason);
		warned = enc.reason;
		return { ok: false, reason: enc.reason };
	}
	saveProblem.set('');
	safeStorage.setItem(saveKey(gameId()), enc.json);
	return { ok: true, bytes: enc.bytes };
}

/** the stored record, upgraded against the game as it is now (null = none) */
export function readSave() {
	const raw = safeStorage.getItem(saveKey(gameId()));
	if (!raw) return { save: null, notes: [] };
	try {
		return upgradeSave(JSON.parse(raw), sceneLevelsTable());
	} catch {
		return { save: null, notes: ['the saved progress was unreadable'] };
	}
}

/**
 * Resume the saved game (an export's boot, after its scene loaded): the level, the kept state, then the
 * checkpoint. @returns {Promise<{resumed: boolean, notes: string[]}>}
 */
export async function resumeSavedGame() {
	if (!persisting()) return { resumed: false, notes: [] };
	const { save, notes } = readSave();
	if (!save) return { resumed: false, notes };
	const travel = await import('./travel.js');
	if (save.level) await travel.goToLevel(save.level, { transition: false });
	else if (save.scene && save.scene !== (await sceneNow())) await travel.hopTo({ scene: save.scene }, { transition: false });
	travel.restoreKept(save.kept);
	if (save.point?.spawn) {
		checkpointPoint.set({ ...save.point, scene: await sceneNow() });
		setPlayerSpawn(save.point.spawn);
	}
	return { resumed: true, notes };
}

/** New game: forget this player's save, reset what the game keeps, go to the first level */
export async function newGame() {
	safeStorage.removeItem(saveKey(gameId()));
	checkpointPoint.set(null);
	saveProblem.set('');
	clearPlayerSpawn();
	const table = sceneLevelsTable();
	resetOwnKept(table);
	const score = kit.impls.score;
	if (table?.keep?.includes('score') && score) {
		score.set(0);
		for (const id of Object.keys(kit.doc()?.slices?.score?.players ?? {})) score.set(0, id);
	}
	const first = table?.list?.[0];
	if (first) await (await import('./travel.js')).goToLevel(first.id);
	else respawnNow();
	return true;
}

let installed = false;
/** attach the kit's checkpoint calls (once, from the levels runtime) */
export function installCheckpoints() {
	if (installed) return;
	installed = true;
	kit.impls.levels?.extra?.attachProgress?.({
		respawn: () => respawnAtCheckpoint(),
		newGame: () => {
			void newGame();
			return true;
		},
		checkpoint: () => get(checkpointPoint)?.name ?? ''
	});
}

/** test seam @param {{persist?: boolean | null}} [opts] */
export function checkpointsForTest(opts = {}) {
	if ('persist' in opts) persistOverride = opts.persist ?? null;
	return { point: get(checkpointPoint), key: saveKey(gameId()), persisting: persisting() };
}
