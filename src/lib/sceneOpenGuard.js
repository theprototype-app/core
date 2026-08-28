// R22 ROUND 30 B1 — THE UNSAVED-CHANGES GUARD, in one place.
//
// Opening a scene REPLACES the world. That is the one action in the app that can only
// lose work, and until now the question it has to ask lived inside Explorer.svelte's
// `openSceneItem` — so the second caller (the peers popover's "Go to", which travels to
// the scene a peer is standing in) would have had to copy it. A guard with two copies is
// a guard with one bug.
//
// WHY A MODULE OF ITS OWN, and not `levels.js` where travel lives: `sceneIdentity`
// imports `levels` (for currentLevel + sceneSignature), and the guard has to ask
// sceneIdentity for the CURRENT verdict — housing it in levels closes that cycle. This
// is a LEAF over both: stores, levels and sceneIdentity in, nothing importing it back.
//
// AND WHAT IS DELIBERATELY NOT GUARDED: the travel NODE. A pulse in a replicated graph
// is the author's intent expressed as gameplay, arriving on every peer at once — there
// is nobody at a dialog to answer it, and a modal per hop would break the campaign the
// node exists to build. The guard belongs to the AUTHORING routes, where one person is
// looking at one screen and chose to leave.
//
// 21-I4, on the shape of the question. This replaces the world, so an unsaved current
// scene asks first — the DCC standard, and the reason `sceneDirty` exists. That flag is
// READ everywhere else and RECOMPUTED here: 21-G9 keeps it behind a throttle precisely
// because the answer costs a whole-scene serialization, which is the right trade for a
// TITLE BAR and the wrong one for the action that destroys the work.

import { get } from 'svelte/store';
import { showToast } from '../stores/appStore';
import { objectsGroup } from '../stores/sceneStore';
import { currentLevel, publishCurrentIfChanged, saveSceneAsLevel } from './levels';
import { recomputeSceneDirty } from './sceneIdentity';
import { showChoice } from './confirmDialog';
import { activeFolder } from './explorer';

/**
 * Ask before replacing the open scene, and honour the answer.
 *
 * @param {string} targetLabel what the caller is about to open — a file name, a scene
 *   name, whatever the user just pointed at. It goes in the title, so the dialog names
 *   the thing that is about to arrive as well as the thing about to go.
 * @returns {Promise<boolean>} true = go ahead (nothing at risk, "Open anyway", or the
 *   save has already been written), false = the user cancelled and nothing was touched.
 */
export async function guardSceneReplace(targetLabel) {
	const at = get(currentLevel);
	// REPORTED (bug 2): this used to read `$sceneDirty` — the THROTTLED verdict, which
	// 21-G9 deliberately lets lag a very recent edit by up to SIGNATURE_THROTTLE_MS (2s)
	// because recomputing costs a whole-scene serialization. That is the right trade for a
	// TITLE BAR and the wrong one here: edit, immediately open another scene, and the guard
	// read a stale `false`, so no dialog appeared and the work was gone. The one place the
	// answer must be current is the action that destroys it, so it is recomputed
	// synchronously; everywhere else keeps the throttle.
	//
	// The second half is a scene with NO IDENTITY to be dirty against. recomputeSceneDirty
	// answers false for it by construction ("nothing to be dirty AGAINST"), which is honest
	// but leaves the newest, least-saved work in the app completely unguarded. If there is
	// no identity and the world is not empty, opening still destroys something, so it asks.
	const identified = !!at?.name && typeof at?.signature === 'string';
	const risky = identified
		? recomputeSceneDirty()
		: (get(objectsGroup)?.children?.length ?? 0) > 0;
	if (!risky) return true;

	const here = at?.name ?? 'This scene';
	const choice = await showChoice({
		title: `Open "${targetLabel}"?`,
		message: identified
			? `"${here}" has unsaved changes, and opening a scene replaces what is on screen.`
			: 'The scene on screen has never been saved, and opening a scene replaces it.',
		// "Open anyway", NOT "Open without saving": travel's own writer-side auto-publish
		// (fork 9) runs inside `travelToLevel` whatever is chosen here, so a named scene
		// normally banks a version on the way out and the stronger label would be a lie.
		// What "Save and open" adds is the cases that rule excludes — a viewer, a loose
		// .tpscene, auto-versions switched off — and a deliberate one rather than an
		// automatic one.
		choices: [
			{ value: 'save', label: 'Save and open' },
			{ value: 'open', label: 'Open anyway', color: 'red' }
		]
	});
	if (!choice) return false;
	if (choice === 'save') {
		// the ordinary write-back first — it lands the new version BESIDE the one it
		// supersedes and under the project's own rules. It answers false for the three cases
		// those rules exclude (a viewer, a loose .tpscene opened from disk, an unnamed
		// scene), and there an explicit save is what the user just asked for: it always
		// writes a local item, and for a loose scene it is exactly the "Save into project"
		// offer of fork 12.
		//
		// `here` falls back to 'This scene' for a scene with no name at all, and that
		// fallback is carried VERBATIM from the Explorer: it is the name the file is saved
		// under, which is odd, and changing it here would be a redesign smuggled into a
		// move. Left as it was, deliberately.
		const published = await publishCurrentIfChanged({ force: true });
		if (published) showToast(`Saved a version of "${here}" first`);
		else await saveSceneAsLevel(here, get(activeFolder) ?? null);
	}
	return true;
}
