// 93 LP0 / LP1 / LP4 — GOING TO A LEVEL. A row of the Levels table is a scene (travel there), a spot in a
// scene (an object to start at), or both. Three callers, one function:
//
//   the Kit: Levels nodes   Go to level / Next level → kit.levels `selected`, heard on EVERY peer → each
//                           peer goes (group travel, the travel-node rule: the replicated pulse is the netcode)
//   a portal (LP1)          THIS player only (peers may stand in different scenes: the rooms layer); the
//                           `selected` event it causes carries `solo`, so other peers do not follow
//   New game / a save (LP3) this player, on load
//
// A scene hop goes through levels.travelToScene (the LOCAL silent replace); what it carries besides the game
// state (the table itself, the keep list's kit score) rides the travel-carry seam registered here.
import { get } from 'svelte/store';
import { scenePhysicsState_, normalizeScenePhysics } from '../scenePhysics';
import { kit } from '../kit/runtime.js';
import { gameState } from '../gameState';
import { peers } from '../../stores/appStore';
import { levelRow } from './table.js';
import { sceneLevelsTable } from './runtime.js';
import { captureKept, shapeCarriedGame, restoreOwnKept, hasKeepList } from './keep.js';
import { landAt, clearPlayerSpawn, respawnNow } from './spawn.js';

/** a primed levels.js (sessions-family: never a static edge from here) @type {any} */
let levelsRef = null;
/** @returns {Promise<any>} */
async function levelsModule() {
	return (levelsRef ??= await import('../levels.js'));
}

const me = () => /** @type {any} */ (get(peers))?.peer?.id ?? '';
const alone = () => ![.../** @type {any} */ (get(peers))?.openedPeers ?? []].length;

/** the level this peer is arriving at (its own `selected` echo must not send it again) */
let arriving = { id: '', at: 0 };
/** @type {Promise<any> | null} one hop at a time */
let inFlight = null;

/** the scene this peer stands in ('' = unnamed) */
export async function currentSceneName() {
	const m = await levelsModule();
	return /** @type {any} */ (get(m.currentLevel))?.name ?? '';
}

/** what this peer's travel carries (the levels table, the kept state); registered with levels.js */
export const levelsTravelCarry = {
	capture() {
		const table = sceneLevelsTable();
		if (!table) return null;
		const vars = get(gameState)?.vars ?? {};
		const score = kit.doc()?.slices?.score ?? null;
		return { table, kept: captureKept(table, { vars, score }) };
	},
	/** @param {any} carried @param {any} captured */
	shapeGame(carried, captured) {
		return shapeCarriedGame(carried, captured?.table);
	},
	/** @param {any} captured */
	restore(captured) {
		if (!captured?.table) return;
		// a level scene with no table of its own keeps the game's (LOCAL: every traveller does this itself)
		const state = get(scenePhysicsState_);
		if (!state.levels) scenePhysicsState_.set(normalizeScenePhysics({ ...state, levels: captured.table }));
		if (!hasKeepList(captured.table)) return;
		restoreKept(captured.kept);
	}
};

/** put kept state back after a load / on a saved game's restore (LP4 / LP5) @param {any} kept */
export function restoreKept(kept) {
	if (!kept) return;
	const score = kit.impls.score;
	if (kept.score && score) {
		// kept score = not zeroed by the next level's round
		score.extra?.configure?.({ autoReset: false });
		score.set(kept.score.total);
		for (const [id, n] of Object.entries(kept.score.players ?? {})) score.set(n, id);
	}
	restoreOwnKept(kept);
}

/**
 * Go to a level of the scene's table: its scene (a hop, with the keep list carried) and / or its start object.
 * @param {string} id the row id
 * @param {{solo?: boolean, fromSelect?: boolean}} [opts] `solo`: only this player (a portal)
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function goToLevel(id, opts = {}) {
	const table = sceneLevelsTable();
	const row = levelRow(table, id);
	if (!row) return { ok: false, reason: 'no level ' + String(id ?? '') };
	if (inFlight) await inFlight.catch(() => {});
	const run = hop(row, opts);
	inFlight = run;
	try {
		return await run;
	} finally {
		if (inFlight === run) inFlight = null;
	}
}

/** @param {any} row @param {{solo?: boolean, fromSelect?: boolean}} opts */
async function hop(row, opts) {
	arriving = { id: row.id, at: Date.now() };
	const here = await currentSceneName();
	let moved = false;
	if (row.scene && row.scene !== here) {
		const m = await levelsModule();
		const ok = await m.travelToScene(row.scene);
		if (!ok) return { ok: false, reason: 'the scene "' + row.scene + '" could not be opened' };
		moved = true;
		arriving = { id: row.id, at: Date.now() };
	}
	if (row.spawn && landAt(row.spawn)) {
		// landed on the row's start object
	} else {
		clearPlayerSpawn();
		if (moved) respawnNow();
	}
	// the kit's current level went with the scene (a load resets the kit): name it again. A portal's hop is
	// tagged solo so the other players' `selected` listeners stay where they are.
	const levels = kit.impls.levels;
	if (levels && levels.current() !== row.id) {
		if (opts.solo && !alone()) levels.extra?.selectSolo?.(row.id, me());
		else if (!opts.fromSelect || moved) levels.select(row.id);
	}
	return { ok: true };
}

/** the kit `selected` listener: a Go to level / Next level node chose a level for everybody @param {any} p */
function onSelected(p) {
	if (p?.game !== 'scene') return;
	if (p.solo && p.solo !== me()) return;
	// our own echo of a hop we are making (or just made)
	if (p.level === arriving.id && Date.now() - arriving.at < 15000) return;
	void goToLevel(p.level, { fromSelect: true });
}

let installed = false;
/** wire the travel carry + the kit listener (once, from the levels runtime) */
export async function installLevelsTravel() {
	if (installed) return;
	installed = true;
	(await levelsModule()).registerTravelCarry?.(levelsTravelCarry);
	kit.impls.levels?.on?.('selected', onSelected);
}

/** test seam */
export function levelsTravelDebug() {
	return { arriving: { ...arriving }, inFlight: !!inFlight };
}
