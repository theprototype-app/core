// 98 P5 — apply a pro preset: the sky + light (an ENVIRONMENT_PRESETS entry), its exposure and the
// look (tone mapping + post effects) as ONE undo step that replicates like any edit and saves with
// the scene (environment + scenePost are both scene singletons).
import { setEnvironment } from '../environment';
import { replacePostEffects } from '../scenePost';
import { beginHistoryBatch, endHistoryBatch, historyBatchOpen } from '../history';
import { PRO_LOOKS, isProPreset, proLookEntries } from './proPresetsCore.js';

/**
 * @param {string} name product | cinematic | stylised
 * @returns {Promise<{ok: boolean, label?: string, effects?: string[], error?: string}>}
 */
export async function applyProPreset(name) {
	if (!isProPreset(name)) return { ok: false, error: 'unknown preset "' + name + '"' };
	const look = PRO_LOOKS[name];
	// the environment's undo kind lives in a module history's subtree may not import (its body
	// registers the kind) — the scene-setup tools' dynamic-import rule
	const { environmentNow, recordEnvironment } = await import('../ai/sceneSetupHistory.js');
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		const before = environmentNow();
		setEnvironment(name, look.exposure);
		recordEnvironment(before);
		replacePostEffects(/** @type {any[]} */ (proLookEntries(name)));
	} finally {
		if (own) endHistoryBatch('Look: ' + look.label);
	}
	return { ok: true, label: look.label, effects: look.effects.map((e) => e.kind) };
}
