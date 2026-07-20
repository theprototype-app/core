import { writable, get } from 'svelte/store';

// AI provider settings (roadmap #10, A1). A LOCAL per-device preference — the
// only credentials the app stores. Keys live in PLAINTEXT localStorage (there is
// no secure-store precedent here); "Reset settings" (localStorage.clear) wipes
// them. Every provider speaks the OpenAI chat-completions dialect, so one client
// (ai/client.js) covers Grok, Gemini and any vLLM / OpenAI-compatible endpoint.
// See docs/plan/roadmap-10-ai.md.

/**
 * @typedef {Object} AiProviderConfig
 * @property {string} id       stable local id
 * @property {string} preset   preset key ('grok' | 'gemini' | 'custom')
 * @property {string} label    display name
 * @property {string} baseUrl  OpenAI-compatible base (no trailing /chat/completions)
 * @property {string} apiKey   bearer token (plaintext)
 * @property {string} model    model id sent as `model`
 */

/**
 * Built-in presets. Grok + Gemini expose OpenAI-compatible endpoints; "custom"
 * is a blank template for a self-hosted vLLM / OpenAI-compatible server.
 * @type {{preset: string, label: string, baseUrl: string, defaultModel: string}[]}
 */
export const PROVIDER_PRESETS = [
	{
		preset: 'grok',
		label: 'Grok (x.ai)',
		baseUrl: 'https://api.x.ai/v1',
		defaultModel: 'grok-3-mini'
	},
	{
		preset: 'gemini',
		label: 'Gemini (Google)',
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
		defaultModel: 'gemini-2.5-flash'
	},
	{
		preset: 'custom',
		label: 'Custom (vLLM / OpenAI-compatible)',
		baseUrl: '',
		defaultModel: ''
	}
];

/** @param {string} preset */
export function presetFor(preset) {
	return PROVIDER_PRESETS.find((p) => p.preset === preset) ?? PROVIDER_PRESETS[2];
}

const PROVIDERS_KEY = 'aiProviders';
const ACTIVE_KEY = 'aiActiveProvider';
const ENABLED_KEY = 'aiEnabled';

/** @returns {AiProviderConfig[]} */
function loadProviders() {
	try {
		const raw = localStorage.getItem(PROVIDERS_KEY);
		const parsed = raw ? JSON.parse(raw) : null;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** @param {AiProviderConfig[]} list */
function persistProviders(list) {
	try {
		localStorage.setItem(PROVIDERS_KEY, JSON.stringify(list));
	} catch {}
}

/** Saved provider configs (list — a user can keep Grok + several vLLM boxes).
 * @type {import('svelte/store').Writable<AiProviderConfig[]>} */
export const aiProviders = writable(loadProviders());

/** id of the active provider, or null.
 * @type {import('svelte/store').Writable<string|null>} */
export const aiActiveProvider = writable(
	(() => {
		try {
			return localStorage.getItem(ACTIVE_KEY) || null;
		} catch {
			return null;
		}
	})()
);

/** Master on/off for the assistant UI (opt-in; hidden until enabled). */
export const aiEnabled = writable(
	(() => {
		try {
			return localStorage.getItem(ENABLED_KEY) === 'true';
		} catch {
			return false;
		}
	})()
);

let idCounter = 0;
/** @returns {string} a stable-enough local id */
function newId() {
	try {
		if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
	} catch {}
	idCounter += 1;
	return 'ai-' + idCounter + '-' + get(aiProviders).length;
}

/**
 * Add a provider config. Missing label/model fall back to the preset.
 * @param {Partial<AiProviderConfig>} config
 * @returns {string} the new id
 */
export function addAiProvider(config) {
	const preset = presetFor(config.preset ?? 'custom');
	/** @type {AiProviderConfig} */
	const entry = {
		id: newId(),
		preset: preset.preset,
		label: (config.label || preset.label).trim(),
		baseUrl: (config.baseUrl ?? preset.baseUrl).trim().replace(/\/+$/, ''),
		apiKey: (config.apiKey ?? '').trim(),
		model: (config.model || preset.defaultModel).trim()
	};
	const list = [...get(aiProviders), entry];
	aiProviders.set(list);
	persistProviders(list);
	// first provider becomes active automatically
	if (!get(aiActiveProvider)) setAiActiveProvider(entry.id);
	return entry.id;
}

/**
 * @param {string} id
 * @param {Partial<AiProviderConfig>} patch
 */
export function updateAiProvider(id, patch) {
	const list = get(aiProviders).map((p) => {
		if (p.id !== id) return p;
		const next = { ...p, ...patch };
		if (typeof next.baseUrl === 'string') next.baseUrl = next.baseUrl.trim().replace(/\/+$/, '');
		if (typeof next.label === 'string') next.label = next.label.trim();
		if (typeof next.apiKey === 'string') next.apiKey = next.apiKey.trim();
		if (typeof next.model === 'string') next.model = next.model.trim();
		return next;
	});
	aiProviders.set(list);
	persistProviders(list);
}

/** @param {string} id */
export function removeAiProvider(id) {
	const list = get(aiProviders).filter((p) => p.id !== id);
	aiProviders.set(list);
	persistProviders(list);
	if (get(aiActiveProvider) === id) {
		setAiActiveProvider(list.length ? list[0].id : null);
	}
}

/** @param {string|null} id */
export function setAiActiveProvider(id) {
	aiActiveProvider.set(id);
	try {
		if (id) localStorage.setItem(ACTIVE_KEY, id);
		else localStorage.removeItem(ACTIVE_KEY);
	} catch {}
}

/** @param {boolean} on */
export function setAiEnabled(on) {
	aiEnabled.set(!!on);
	try {
		localStorage.setItem(ENABLED_KEY, String(!!on));
	} catch {}
}

/** The active provider config, or null if none is selected/valid.
 * @returns {AiProviderConfig|null} */
export function activeAiConfig() {
	const id = get(aiActiveProvider);
	if (!id) return null;
	return get(aiProviders).find((p) => p.id === id) ?? null;
}

/** Whether the assistant can run (enabled + a usable active provider).
 * @returns {boolean} */
export function aiReady() {
	if (!get(aiEnabled)) return false;
	const cfg = activeAiConfig();
	return !!(cfg && cfg.baseUrl && cfg.model);
}
