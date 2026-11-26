// 63-publish — THE PUBLISH CHECK AS DATA, for the two callers that are not the Publish tab: the
// agent's save_scene result and the cloudApi `publishCheck` seam (the cloud plugin, its
// connector). Same rules, same rows as the tab. An agent reads it and tells the person; it never
// presses a fix or Publish itself — both stay a person's press in the tab (the in-tab confirm).
// Lazy: only those two callers import it.
import { runChecks, summarize } from './checkCore.js';
import { SCENE_RULES } from './sceneChecks.js';

export const PUBLISH_CHECK_NOTE =
	'What a visitor would hit if this scene were published. Publishing and every fix are the person\'s press in the Publish tab; tell them, do not act.';

/**
 * @param {{target?: string, bundle?: boolean, phone?: boolean}} [opts] `bundle` (default false
 *   for speed) also measures the bundle against the publish limit
 * @returns {Promise<{target: string, summary: {error: number, warn: number, info: number, blocking: number},
 *   problems: {id: string, severity: string, title: string, detail?: string, items?: string[], fix?: string, fixLabel?: string}[],
 *   fixes: string[], note: string}>}
 */
export async function publishCheckData(opts = {}) {
	const target = opts.target || 'publish';
	const { gatherSceneFacts } = await import('./sceneFacts.js');
	const scene = await gatherSceneFacts({ target, bundle: opts.bundle === true });
	const rows = await runChecks(SCENE_RULES, { target, scene, ...(typeof opts.phone === 'boolean' ? { phone: opts.phone } : {}) });
	return {
		target,
		summary: summarize(rows, target),
		problems: rows.map((r) => ({
			id: r.id,
			severity: r.severity,
			title: r.title,
			...(r.detail ? { detail: r.detail } : {}),
			...(r.items?.length ? { items: r.items.map((i) => i.label) } : {}),
			...(r.fix ? { fix: r.fix.name, fixLabel: r.fix.label } : {})
		})),
		fixes: [...new Set(rows.flatMap((r) => (r.fix ? [r.fix.name] : [])))],
		note: PUBLISH_CHECK_NOTE
	};
}
