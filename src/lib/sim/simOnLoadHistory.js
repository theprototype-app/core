// 36-fb-water S8: "Start simulation on load" is UNDOABLE (Ctrl+Z / Ctrl+Y, replicated like the
// setting itself). Its own history kind in its own module: this file's BODY calls
// registerHistoryKind, so nothing in history's import subtree may reach it — only the setting's
// component (and the debug hook) import it, which is the rule CLAUDE.md states for flowGraphs/joints.
import { get } from 'svelte/store';
import { recordEntry, registerHistoryKind } from '../history';
import { setScenePhysics, scenePhysicsState_ } from '../scenePhysics';

registerHistoryKind('simonload', (/** @type {any} */ entry, /** @type {any} */ state) => {
	setScenePhysics({ simOnLoad: state?.on === true });
	return true;
});

/** the ONE write path for the checkbox: set (replicated by setScenePhysics) + one undo entry
 * @param {boolean} on */
export function setSimOnLoad(on) {
	const before = get(scenePhysicsState_).simOnLoad === true;
	if (before === !!on) return false;
	setScenePhysics({ simOnLoad: !!on });
	recordEntry({ kind: 'simonload', before: { on: before }, after: { on: !!on } });
	return true;
}
