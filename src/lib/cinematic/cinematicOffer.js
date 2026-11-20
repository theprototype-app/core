// 100 C1 — the part of the Cinematic view's rules the BOOT path needs (pure, imports nothing): where the
// switch is offered and what a stored quality means. The rest of the rules are ./cinematicCore.js (lazy).

/** @typedef {'basic'|'standard'|'high'} Quality */

/** the quality a device starts with */
export const DEFAULT_QUALITY = /** @type {Quality} */ ('standard');

/** @param {any} q @returns {Quality} */
export function asQuality(q) {
	return q === 'basic' || q === 'standard' || q === 'high' ? q : DEFAULT_QUALITY;
}

/**
 * Is the switch offered here? Every fact is gathered by the caller (cinematicState.js).
 * @param {{
 *   desktop: boolean,          // deviceClass 'desktop' and the browser does not call itself mobile
 *   quest?: boolean,           // a Quest / headset browser
 *   xr?: boolean,              // presenting in a headset now
 *   gpu: boolean,              // navigator.gpu exists
 *   adapter?: boolean,         // requestAdapter() answered
 *   fallbackAdapter?: boolean, // the adapter is a software one (SwiftShader)
 *   chromium?: boolean,        // a Chromium browser (Chrome / Edge): the default backend the lighting was proven on
 *   disabled?: string          // this session turned it off after a failure (the reason)
 * }} f
 * @returns {{ offered: boolean, why: string }}
 */
export function offerVerdict(f) {
	if (f.disabled) return { offered: false, why: f.disabled };
	if (!f.desktop || f.quest) return { offered: false, why: 'Only on a desktop computer.' };
	if (f.xr) return { offered: false, why: 'Not in a headset.' };
	if (!f.gpu) return { offered: false, why: 'This browser has no WebGPU.' };
	if (!f.chromium) return { offered: false, why: 'Needs Chrome or Edge (WebGPU on the default graphics path).' };
	if (!f.adapter) return { offered: false, why: 'No WebGPU graphics adapter here.' };
	if (f.fallbackAdapter) return { offered: false, why: 'This graphics adapter is a software one.' };
	return { offered: true, why: '' };
}

