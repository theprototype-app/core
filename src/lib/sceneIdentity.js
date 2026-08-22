// 21-G9 — WHERE AM I, AND HAS IT CHANGED: the window title.
//
// "Scene* - Project - theprototype" is the identity line every DCC puts in its title
// bar, and it is the only place the app can answer "which of my three tabs is the
// dungeon" without the user clicking into one. The asterisk is the same convention:
// this scene differs from the version its NAME points at in the project.
//
// THE COST RULE, which shapes everything here: "has it changed" is `sceneSignature` over
// `buildSessionPayload`, and that call serializes the WHOLE scene — every object's
// toJSON, every graph, plus a rendered thumbnail. It may never run per keystroke, per
// gesture or per frame. Three gates keep it cheap:
//
//   1. it runs only on a DIRTY PULSE (autosave's own change signal — no second set of
//      subscriptions, and nothing at all happens in an idle editor),
//   2. THROTTLED: at most one recomputation per SIGNATURE_THROTTLE_MS,
//   3. and NOT AT ALL once the answer is already "dirty" — the flag cannot go back to
//      clean without a save or a travel, and both of those write `currentLevel`, which
//      resets it directly. So an editing session pays for exactly ONE serialization.
//
// It is also skipped while PLAYING: a game moves objects constantly and none of that is
// an edit anyone wants an asterisk for.
//
// A LEAF in the App-startup sense (the startInputRuntime shape): idempotent
// `startSceneIdentity()`, plain store subscriptions, nothing reaches back into it.

import { writable, get } from 'svelte/store';
import { isLocked } from '../stores/sceneStore';
import { currentLevel, sceneSignature } from './levels';
import { buildSessionPayload } from './sessions';
import { projectManifest } from './projectManifest';
import { dirtyPulse } from './autosave';

/** what the app is called, at the end of every title */
export const APP_TITLE = 'theprototype';
/** the floor between two full-scene serializations (the COST RULE above) */
export const SIGNATURE_THROTTLE_MS = 2000;

/** Does the open scene differ from the version its name points at? False whenever the
 * question does not apply (no named scene yet). @type {import('svelte/store').Writable<boolean>} */
export const sceneDirty = writable(false);

/**
 * The title string. Pure, so the shape is testable without a document:
 *   scene + project -> "Arena* - Dungeon Crawl - theprototype"
 *   scene only      -> "Arena* - theprototype"
 *   project only    -> "Dungeon Crawl - theprototype"
 *   neither         -> "theprototype"
 * @param {string} scene @param {string} project @param {boolean} dirty @returns {string}
 */
export function composeTitle(scene, project, dirty) {
	const parts = [];
	if (scene) parts.push(scene + (dirty ? '*' : ''));
	if (project) parts.push(project);
	parts.push(APP_TITLE);
	return parts.join(' - ');
}

/**
 * The expensive half, run behind all three gates. Returns the verdict it settled on.
 * @returns {boolean}
 */
export function recomputeSceneDirty() {
	const at = get(currentLevel);
	// no named scene = nothing to be dirty AGAINST (the "unsaved scene" case; the
	// ordinary autosave still protects it, it simply has no identity to compare with)
	if (!at?.name || typeof at.signature !== 'string') {
		sceneDirty.set(false);
		return false;
	}
	// playing is not editing
	if (get(isLocked) === true) return get(sceneDirty);
	let signature = '';
	try {
		const payload = /** @type {any} */ (buildSessionPayload(at.name));
		signature = sceneSignature(payload);
	} catch {
		return get(sceneDirty); // a scene that cannot be serialized says nothing new
	}
	const dirty = signature !== at.signature;
	sceneDirty.set(dirty);
	return dirty;
}

/** @type {any} */ let throttleTimer = null;

/** Arm the throttled check, unless it would tell us something we already know. */
function scheduleCheck() {
	if (throttleTimer || get(sceneDirty)) return;
	throttleTimer = setTimeout(() => {
		throttleTimer = null;
		recomputeSceneDirty();
	}, SIGNATURE_THROTTLE_MS);
}

let started = false;

/** Install the title. Idempotent; a no-op without a document (SSR). */
export function startSceneIdentity() {
	if (started || typeof document === 'undefined') return;
	started = true;
	const apply = () => {
		const at = get(currentLevel);
		document.title = composeTitle(
			at?.name ?? '',
			get(projectManifest).name ?? '',
			get(sceneDirty)
		);
	};
	// arriving somewhere — a save or a travel — makes the open scene EQUAL to the
	// version it now points at, by construction: both write the signature they wrote or
	// read. So this is the one place the flag legitimately goes back to clean.
	currentLevel.subscribe(() => {
		sceneDirty.set(false);
		apply();
	});
	projectManifest.subscribe(apply);
	sceneDirty.subscribe(apply);
	dirtyPulse.subscribe(() => scheduleCheck());
}
