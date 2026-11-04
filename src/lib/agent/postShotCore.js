// mcp-diorama2 (item 7) — the pure half of postShot.js (imports nothing): why a screen draws no post effects.

/** where a person raises this device's quality (Settings ▸ Scene ▸ Performance, or Configure Scene ▸ Quality) */
export const QUALITY_HOW =
	'On this device: Settings ▸ Scene ▸ Performance ▸ Quality preset: High (or Configure Scene ▸ Quality). An agent may ask with set_quality {"level": "high"} — the person answers Allow / Keep on their own screen.';

/**
 * Why nothing is drawn — pure (unit-tested). `reason` is a short code an agent can branch on, `detail` the words,
 * `how` what would change it (null when nothing on this device would).
 * @param {{authored: number, mode: string, localOn: boolean, ok: boolean, postOff: boolean, level?: number, major?: number}} f
 * @returns {{reason: string, detail: string, how: string | null}}
 */
export function postOffReason(f) {
	if (!f.authored) return { reason: 'no effects', detail: 'the scene has no post effects', how: 'set_look {"action": "post"} adds bloom, a vignette, a colour grade …' };
	if (f.mode === 'wireframe') return { reason: 'wireframe', detail: 'this screen shows the scene in wireframe, which draws no post effects; the scene keeps them for everyone else', how: 'the person switches the view back to Shaded (View menu)' };
	if (!f.ok)
		return {
			reason: 'browser',
			detail: 'this browser (Chromium ' + (f.major || 'unknown') + ') draws post effects badly, so the app leaves them out here; the scene keeps them for everyone else',
			how: null
		};
	if (!f.localOn) return { reason: 'switched off here', detail: 'the person switched the scene look off on this device; peers still see it', how: 'the person switches it back on: View ▸ Overrides' };
	if (f.postOff)
		return {
			reason: 'quality tier',
			detail: 'this device turned post effects off to keep its frame rate (automatic quality' + (f.level ? ', step ' + f.level : '') + ' — usual on a phone); nothing was changed for it, and the scene keeps its post effects for screens that can afford them',
			how: QUALITY_HOW
		};
	return { reason: 'not drawn', detail: 'post effects are not drawn here right now', how: null };
}

