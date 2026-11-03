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

/** Is this address the person's own machine or local network? Anything else is somebody's server. @param {string} url */
export function isPrivateHost(url) {
	let host = '';
	try {
		host = new URL(String(url)).hostname.toLowerCase().replace(/^\[|\]$/g, '');
	} catch {
		return false;
	}
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') return true;
	const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
	if (!v4) return /^f[cd][0-9a-f]{2}:|^fe80:/.test(host); // IPv6 unique-local / link-local
	const [a, b] = [Number(v4[1]), Number(v4[2])];
	return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * 73 AI7: the consent text for a picture leaving this device for somebody else's server, or null when
 * none is needed: only a ComfyUI on this machine or the local network is the person's own. A hosted
 * preset (a plugin's `managedBy`) and a ComfyUI anywhere else ask too.
 * @param {{kind: string, label: string, mode?: string, managedBy?: string, baseUrl?: string}} cfg
 * @returns {{title: string, message: string, link?: {href: string, label: string}, send: string} | null}
 */
export function pictureConsentFor(cfg) {
	if (cfg.kind === 'meshy') {
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
	if (!cfg.managedBy && isPrivateHost(cfg.baseUrl ?? '')) return null;
	const label = String(cfg.label || 'this provider');
	let where = 'its server';
	try {
		where = new URL(String(cfg.baseUrl)).host || where;
	} catch {
		/* a hosted preset may carry no address of its own */
	}
	return {
		title: 'Send this picture to ' + label + '?',
		message:
			(cfg.managedBy
				? label + ' is a hosted service: the picture leaves this device for its servers (location data is already removed), and the model uses your hosted credits.\n'
				: label + ' runs on ' + where + ', not on this device or your local network: the picture leaves this device for that server (location data is already removed).\n') +
			'Cancel sends nothing.',
		send: 'Send'
	};
}
