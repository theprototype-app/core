// 73 AI7 + AI4 — the words around a generated model: the consent before a picture goes to a hosted provider,
// and errors that name the provider. A leaf (imports nothing), so the dialog and the unit tests read it cheaply.

/**
 * 73 AI4: an error a person can act on names the provider (an adapter's own wording usually does; a
 * network failure or a bare "generation failed" does not).
 * @param {string} msg @param {{label: string, kind: string}} cfg
 */
export function namedError(msg, cfg) {
	const names = [cfg.label, cfg.kind, cfg.kind === 'meshy' ? 'Meshy' : 'ComfyUI'].filter(Boolean).map((n) => n.toLowerCase());
	const low = msg.toLowerCase();
	if (names.some((n) => low.includes(n))) return msg;
	if (/failed to fetch|networkerror|load failed/i.test(msg)) return cfg.label + ' could not be reached — check the connection and the address in Settings ▸ Tools & connections';
	return cfg.label + ': ' + msg;
}

/** Credits per image-to-3D task, Meshy's price list (docs.meshy.ai/api/pricing, read 2026-09-23): the
 * default (latest) model, untextured / textured. A guide, not a bill: Meshy charges what it charges. */
export const MESHY_IMAGE_CREDITS = { preview: 20, refine: 30 };
export const MESHY_PRIVACY_URL = 'https://www.meshy.ai/privacy-policy';

/**
 * 73 AI7: the consent text for a picture going to a hosted provider, or null when none is needed (a
 * self-hosted ComfyUI is the person's own server).
 * @param {{kind: string, label: string, mode?: string}} cfg
 * @returns {{title: string, message: string, link: {href: string, label: string}, send: string} | null}
 */
export function pictureConsentFor(cfg) {
	if (cfg.kind !== 'meshy') return null;
	const refine = cfg.mode === 'refine';
	const credits = refine ? MESHY_IMAGE_CREDITS.refine : MESHY_IMAGE_CREDITS.preview;
	return {
		title: 'Send this picture to Meshy?',
		message:
			`Meshy is a third-party service: the picture leaves this device for Meshy's servers (location data is already removed).\n` +
			`This uses about ${credits} credits of your Meshy account (${refine ? 'Refine, textured' : 'Preview, untextured'}; Meshy's price list).\n` +
			'Cancel sends nothing.',
		link: { href: MESHY_PRIVACY_URL, label: "Meshy's privacy policy" },
		send: 'Send to Meshy'
	};
}

