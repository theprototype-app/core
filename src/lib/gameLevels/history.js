// 93 LP0 — undo for the Levels table (the panel and the agent's game_setup {levels} both write it).
// The `levels` kind restores the WHOLE recorded table through scenePhysics' own write path, so an undo
// replicates like the edit did. This file's BODY calls registerHistoryKind, so nothing in history's
// import subtree may reach it: only the panel and the agent tools load it, dynamically.
import { get } from 'svelte/store';
import { recordEntry, registerHistoryKind } from '../history';
import { setScenePhysics, scenePhysicsState_ } from '../scenePhysics';

/** a copy of the scene's Levels table (null = none) */
export function levelsNow() {
	const t = get(scenePhysicsState_)?.levels ?? null;
	return t ? JSON.parse(JSON.stringify(t)) : null;
}

registerHistoryKind('levels', (/** @type {any} */ entry, /** @type {any} */ state) => {
	setScenePhysics({ levels: state === entry.before ? entry.before : entry.after });
	return true;
});

/** write the table as ONE undo step @param {any} next the new table (null = remove it) */
export function commitLevels(next) {
	const before = levelsNow();
	setScenePhysics({ levels: next });
	const after = levelsNow();
	if (JSON.stringify(before) !== JSON.stringify(after)) recordEntry({ kind: 'levels', before, after });
	return after;
}
