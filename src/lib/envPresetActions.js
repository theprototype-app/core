// 78-int PL16 + PL12 — the environment's Reset and row resets as ONE undo step each. Every write goes
// through environment.js's own path (commit → persist + replicate), so peers see a reset like any edit.
// The environment's undo kind lives in ai/sceneSetupHistory.js, whose BODY registers it: nothing in
// history's import subtree may import it statically, so it loads on first use (the proPresets rule).
import { get } from 'svelte/store';
import { environment, setEnvironment, ENVIRONMENT_PRESETS } from './environment';
import { basedOnOf, presetExposure } from './envPresetCore.js';

/**
 * Run an environment edit as one undo step (and one message).
 * @param {() => void} fn
 */
export async function envUndoable(fn) {
	const { environmentNow, recordEnvironment } = await import('./ai/sceneSetupHistory.js');
	const before = environmentNow();
	fn();
	recordEnvironment(before);
}

/** the preset the environment comes from (a named one, or an edited copy's `basedOn`) */
export function envBasePreset() {
	const key = basedOnOf(get(environment), ENVIRONMENT_PRESETS);
	return key ? { key, preset: /** @type {any} */ (ENVIRONMENT_PRESETS)[key] } : null;
}

/**
 * Reset: re-apply the preset the environment is based on, as one undo step. A pro look re-applies its
 * effects too (its own one-step path). Extra environment lights stay, as on any preset switch.
 * @returns {Promise<boolean>} false = no preset to go back to
 */
export async function resetEnvironmentPreset() {
	const base = envBasePreset();
	if (!base) return false;
	if (base.preset.pro) {
		const { applyProPreset } = await import('./post/proPresets.js');
		await applyProPreset(base.key);
		return true;
	}
	await envUndoable(() => setEnvironment(base.key, presetExposure(base.preset)));
	return true;
}
