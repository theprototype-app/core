// Roadmap 73 AI8 + AI11 — WHICH ASSISTANT MODELS TAKE PICTURES, AND HOW MANY / HOW BIG, said BEFORE the
// person picks one. A leaf (imports only the attachment limits, themselves a leaf).
//
// AI11 (owner B2): pictures only where they already work. The client speaks OpenAI chat-completions with
// `image_url` parts; Gemini's OpenAI layer and xAI's vision models read that today. A Custom server is
// "maybe": we cannot know what its model is, so it may try, and a refusal says so (assistant.pictureFailure).
// OpenAI's and Anthropic's own endpoints have no preset yet (a later release's provider presets), so a Custom
// entry pointed at them is greyed rather than sent from the browser untested.
//
// AI8: the limits shown are what THIS app sends (attachCore): at most MAX_ATTACHMENTS pictures a message,
// each downscaled to MAX_EDGE px and re-encoded under MAX_ATTACH_BYTES, location data removed. Those sit
// under every listed provider's own caps (Gemini: 20 MB a request inline; xAI: 10 MiB a picture), so the
// one line is true for each, and prepareFiles enforces it.
import { MAX_ATTACHMENTS, MAX_EDGE, MAX_ATTACH_BYTES } from '../chat/attachCore.js';

/** a model name that reads as one with vision */
const SEES = /vision|[-_.]vl\b|\bvl[-_]|pixtral|llava|gemma-?3|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|grok-4|grok-2-vision|qwen2(\.5)?-?vl|minicpm-v|internvl|molmo|phi-3\.5-vision|phi-4-multimodal|llama-3\.2-(11|90)b-vision|llama-4/i;
/** a model name that reads as text-only, whatever the server */
const BLIND = /^grok-3|^grok-2(?!-vision)|^grok-code|embedding|^text-|^gemini-.*(embedding|aqa)|deepseek-(r1|v3|chat|coder|reasoner)|^o1-mini|^gpt-3\.5/i;
/** hosts whose own API has no preset yet (a later release adds the presets) */
const NO_PRESET_HOSTS = /^https?:\/\/(api\.openai\.com|api\.anthropic\.com)(\/|$)/i;

/** the composer's limits, one sentence
 * @param {string} [label] the provider's name ('' = generic) */
export function pictureLimitsText(label = '') {
	const who = label ? label + ': ' : '';
	return `${who}up to ${MAX_ATTACHMENTS} pictures a message, each sent as a JPEG up to ${MAX_EDGE} px and ${Math.round(MAX_ATTACH_BYTES / 1024)} KB, location data removed`;
}

/** the model to suggest for pictures on this provider ('' = none known)
 * @param {{preset?: string}} config */
function suggestion(config) {
	if (config.preset === 'grok') return 'grok-4';
	if (config.preset === 'gemini') return 'gemini-flash-latest';
	return '';
}

/**
 * Can the assistant's active provider take pictures?
 * `ok`: true = yes; 'maybe' = a Custom server we cannot know (it may try; a refusal is handled);
 * false = no, with `reason` (shown on the greyed button) and `suggest` (a model that can, or '').
 * @param {{preset?: string, label?: string, baseUrl?: string, model?: string} | null | undefined} config
 * @returns {{ok: true | false | 'maybe', reason: string, suggest: string, limits: string}}
 */
export function visionSupport(config) {
	if (!config) return { ok: false, reason: 'Set up an assistant first', suggest: '', limits: pictureLimitsText() };
	const model = String(config.model || '').trim();
	const label = String(config.label || 'This provider');
	const limits = pictureLimitsText(label);
	const suggest = suggestion(config);
	if (NO_PRESET_HOSTS.test(String(config.baseUrl || ''))) {
		return { ok: false, reason: 'Pictures for this provider need its own preset, which comes in a later release', suggest: '', limits };
	}
	if (BLIND.test(model) || (config.preset === 'grok' && !SEES.test(model))) {
		const offer = suggest && suggest !== model ? ` — pick ${suggest} in Settings ▸ Tools & connections to send pictures` : '';
		return { ok: false, reason: `${model || 'This model'} can’t see pictures${offer}`, suggest, limits };
	}
	if (config.preset === 'gemini' || config.preset === 'grok') return { ok: true, reason: '', suggest, limits };
	if (SEES.test(model)) return { ok: true, reason: '', suggest, limits };
	return {
		ok: 'maybe',
		reason: `${model || 'This model'} may not see pictures; if the server refuses one, the chat says so and goes on without it`,
		suggest,
		limits
	};
}
