// Roadmap 73 AI2 — PICTURES IN THE ASSISTANT'S OWN PROVIDER CHAT, the pure half (imports nothing). The
// client speaks one dialect, OpenAI chat-completions, and that dialect's `image_url` part with a data URI
// is what Gemini's compat layer, OpenAI, Anthropic's compat layer, Grok and vLLM vision models all read.
//
// Pictures are costly in a transcript that is re-sent whole on every turn and every tool round, so only
// the newest KEEP_PICTURE_TURNS turns keep theirs; older ones become a line of text saying one was there.

export const KEEP_PICTURE_TURNS = 2;

/** the user turn's `content`: the plain string with no pictures, else text + image parts
 * @param {string} text @param {{mimeType: string, data: string, name?: string}[]} [images] @returns {string | any[]} */
export function userContent(text, images = []) {
	if (!images.length) return text;
	return [
		{ type: 'text', text },
		...images.map((i) => ({ type: 'image_url', image_url: { url: 'data:' + i.mimeType + ';base64,' + i.data }, tpName: i.name ?? '' }))
	];
}

/** what actually goes on the wire: our `tpName` bookkeeping stays home (strict servers reject unknown keys)
 * @param {any[]} messages @returns {any[]} */
export function wireMessages(messages) {
	return messages.map((m) =>
		Array.isArray(m.content) ? { ...m, content: m.content.map((/** @type {any} */ { tpName: _n, ...part }) => part) } : m
	);
}

/** @param {any} m */
const carriesPictures = (m) => m?.role === 'user' && Array.isArray(m.content) && m.content.some((/** @type {any} */ p) => p.type === 'image_url');

/** @param {any} m */
function withoutPictures(m) {
	const text = m.content.filter((/** @type {any} */ p) => p.type === 'text').map((/** @type {any} */ p) => p.text).join('\n');
	const names = m.content.filter((/** @type {any} */ p) => p.type === 'image_url').map((/** @type {any} */ p) => p.tpName || 'a picture');
	return { ...m, content: text + '\n\n[Attached earlier, no longer shown: ' + names.join(', ') + ']' };
}

/** the transcript with pictures only on its newest `keep` picture turns (a new array; `keep` 0 = none left)
 * @param {any[]} messages @param {number} [keep] @returns {any[]} */
export function limitPictures(messages, keep = KEEP_PICTURE_TURNS) {
	let seen = 0;
	const out = [...messages];
	for (let i = out.length - 1; i >= 0; i--) {
		if (!carriesPictures(out[i])) continue;
		if (++seen > keep) out[i] = withoutPictures(out[i]);
	}
	return out;
}

/** does the transcript hold any picture? @param {any[]} messages */
export const hasPictures = (messages) => messages.some(carriesPictures);

/** a server's answer that reads as "this model takes no pictures" (vLLM, Gemini, OpenAI, Grok wordings)
 * @param {number} status @param {string} body */
export function isVisionRefusal(status, body) {
	if (status < 400 || status >= 500 || status === 401 || status === 403 || status === 429) return false;
	return /image_url|image input|images? (is|are) not supported|does(n't| not) support (images?|vision|multimodal)|not a (vision|multimodal) model|no vision|multimodal|input should be a valid string|content must be a string/i.test(body || '');
}
