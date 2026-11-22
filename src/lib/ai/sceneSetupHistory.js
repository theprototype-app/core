// Roadmap 85 (85-scene) — undo for the two scene singletons that had none: the ENVIRONMENT (sky, fog, exposure,
// rig + environment lights) and the play block's spawn + the H6 opening view. Each kind restores the WHOLE
// recorded value through the singleton's own write path, so an undo replicates like the edit did.
// This file's BODY calls registerHistoryKind, so nothing in history's import subtree may reach it: only the
// scene-setup tools load it, dynamically (the simOnLoadHistory / hudSync rule).
import { get } from 'svelte/store';
import { recordEntry, registerHistoryKind } from '../history';
import { environment, commitEnvironment } from '../environment';
import { setScenePhysics, scenePhysicsState_ } from '../scenePhysics';

/** a copy of the environment's authored state (no stamp) */
export function environmentNow() {
	const s = get(environment);
	return JSON.parse(
		JSON.stringify({ preset: s.preset ?? 'studio', exposure: s.exposure ?? 1, customPreset: s.customPreset ?? null, lights: s.lights ?? [], ...(s.lodBias ? { lodBias: s.lodBias } : {}) })
	);
}

/** the play fields an agent sets: spawn + opening view */
export function scenePlayNow() {
	const s = get(scenePhysicsState_);
	return JSON.parse(JSON.stringify({ spawn: s.play?.spawn ?? null, startView: s.startView ?? null }));
}

registerHistoryKind('environment', (/** @type {any} */ entry, /** @type {any} */ state) => {
	commitEnvironment(state === entry.before ? entry.before : entry.after);
	return true;
});

registerHistoryKind('sceneplay', (/** @type {any} */ entry, /** @type {any} */ state) => {
	const v = state === entry.before ? entry.before : entry.after;
	setScenePhysics({ play: { spawn: v?.spawn ?? null }, startView: v?.startView ?? null });
	return true;
});

/** @param {any} before environmentNow() before the change */
export function recordEnvironment(before) {
	const after = environmentNow();
	if (JSON.stringify(before) !== JSON.stringify(after)) recordEntry({ kind: 'environment', before, after });
}

/** @param {any} before scenePlayNow() before the change */
export function recordScenePlay(before) {
	const after = scenePlayNow();
	if (JSON.stringify(before) !== JSON.stringify(after)) recordEntry({ kind: 'sceneplay', before, after });
}
