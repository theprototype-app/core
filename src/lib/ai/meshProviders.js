import { writable, get } from 'svelte/store';

// Text/image -> 3D mesh generation providers (roadmap #11, G1). Mirrors
// ai/providers.js (the LLM providers) but for mesh backends: a self-hosted ComfyUI
// (running a TRELLIS text->image->3D workflow) or a hosted API (Meshy, ...). LOCAL
// per-device config; keys are PLAINTEXT localStorage (same caveat as LLM keys).
// See docs/plan/roadmap-11-generative-3d.md and docs/ai/generation.md.

/**
 * @typedef {Object} MeshProviderConfig
 * @property {string} id
 * @property {'comfyui'|'meshy'} kind
 * @property {string} label
 * @property {string} baseUrl      no trailing slash
 * @property {string} apiKey       bearer token (plaintext; blank for a LAN ComfyUI)
 * @property {string} [workflowJson]  comfyui: API-format graph w/ {{PROMPT}}/{{SEED}} placeholders
 * @property {string} [outputNodeId]  comfyui: node id whose file output is the GLB (blank = auto-detect)
 * @property {string} [mode]          meshy: 'preview' | 'refine'
 * @property {string} [assetProxy]    meshy: CORS proxy for the GLB download — Meshy's
 *   assets CDN sends no Access-Control-Allow-Origin, so browsers can't fetch the
 *   result directly. Blank = the build-time VITE_ASSET_PROXY default (meshy.js).
 */

/**
 * Presets. ComfyUI is the recommended self-hosted TRELLIS path (text->image->3D in
 * one graph). Meshy is the reference hosted provider.
 * @type {{kind: string, label: string, baseUrl: string, defaults: any}[]}
 */
export const MESH_PRESETS = [
	{
		kind: 'comfyui',
		label: 'ComfyUI (self-hosted TRELLIS)',
		baseUrl: 'http://localhost:8188',
		defaults: { workflowJson: '', outputNodeId: '' }
	},
	{
		kind: 'meshy',
		label: 'Meshy (hosted)',
		baseUrl: 'https://api.meshy.ai',
		defaults: { mode: 'preview' }
	}
];

/** @param {string} kind */
export function meshPresetFor(kind) {
	return MESH_PRESETS.find((p) => p.kind === kind) ?? MESH_PRESETS[0];
}

const PROVIDERS_KEY = 'meshProviders';
const ACTIVE_KEY = 'meshActiveProvider';
const ENABLED_KEY = 'meshGenEnabled';

/** @returns {MeshProviderConfig[]} */
function loadProviders() {
	try {
		const raw = localStorage.getItem(PROVIDERS_KEY);
		const parsed = raw ? JSON.parse(raw) : null;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** @param {MeshProviderConfig[]} list */
function persist(list) {
	try {
		localStorage.setItem(PROVIDERS_KEY, JSON.stringify(list));
	} catch {}
}

/** Saved mesh-provider configs. @type {import('svelte/store').Writable<MeshProviderConfig[]>} */
export const meshProviders = writable(loadProviders());

/** @type {import('svelte/store').Writable<string|null>} */
export const meshActiveProvider = writable(
	(() => {
		try {
			return localStorage.getItem(ACTIVE_KEY) || null;
		} catch {
			return null;
		}
	})()
);

/** Master on/off for mesh generation (opt-in; entry points hidden until enabled). */
export const meshGenEnabled = writable(
	(() => {
		try {
			return localStorage.getItem(ENABLED_KEY) === 'true';
		} catch {
			return false;
		}
	})()
);

let idCounter = 0;
/** @returns {string} */
function newId() {
	try {
		if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
	} catch {}
	idCounter += 1;
	return 'mesh-' + idCounter + '-' + get(meshProviders).length;
}

/**
 * @param {Partial<MeshProviderConfig>} config
 * @returns {string} the new id
 */
export function addMeshProvider(config) {
	const preset = meshPresetFor(config.kind ?? 'comfyui');
	/** @type {MeshProviderConfig} */
	const entry = {
		id: newId(),
		kind: /** @type {any} */ (preset.kind),
		label: (config.label || preset.label).trim(),
		baseUrl: (config.baseUrl ?? preset.baseUrl).trim().replace(/\/+$/, ''),
		apiKey: (config.apiKey ?? '').trim(),
		...preset.defaults,
		...(config.workflowJson !== undefined ? { workflowJson: config.workflowJson } : {}),
		...(config.outputNodeId !== undefined ? { outputNodeId: String(config.outputNodeId).trim() } : {}),
		...(config.mode !== undefined ? { mode: config.mode } : {}),
		...(config.assetProxy !== undefined ? { assetProxy: String(config.assetProxy).trim() } : {})
	};
	const list = [...get(meshProviders), entry];
	meshProviders.set(list);
	persist(list);
	if (!get(meshActiveProvider)) setMeshActiveProvider(entry.id);
	return entry.id;
}

/**
 * @param {string} id
 * @param {Partial<MeshProviderConfig>} patch
 */
export function updateMeshProvider(id, patch) {
	const list = get(meshProviders).map((p) => {
		if (p.id !== id) return p;
		const next = { ...p, ...patch };
		if (typeof next.baseUrl === 'string') next.baseUrl = next.baseUrl.trim().replace(/\/+$/, '');
		if (typeof next.label === 'string') next.label = next.label.trim();
		if (typeof next.apiKey === 'string') next.apiKey = next.apiKey.trim();
		if (typeof next.outputNodeId === 'string') next.outputNodeId = next.outputNodeId.trim();
		if (typeof next.assetProxy === 'string') next.assetProxy = next.assetProxy.trim();
		return next;
	});
	meshProviders.set(list);
	persist(list);
}

/** @param {string} id */
export function removeMeshProvider(id) {
	const list = get(meshProviders).filter((p) => p.id !== id);
	meshProviders.set(list);
	persist(list);
	if (get(meshActiveProvider) === id) setMeshActiveProvider(list.length ? list[0].id : null);
}

/** @param {string|null} id */
export function setMeshActiveProvider(id) {
	meshActiveProvider.set(id);
	try {
		if (id) localStorage.setItem(ACTIVE_KEY, id);
		else localStorage.removeItem(ACTIVE_KEY);
	} catch {}
}

/** @param {boolean} on */
export function setMeshGenEnabled(on) {
	meshGenEnabled.set(!!on);
	try {
		localStorage.setItem(ENABLED_KEY, String(!!on));
	} catch {}
}

/** @returns {MeshProviderConfig|null} */
export function activeMeshConfig() {
	const id = get(meshActiveProvider);
	if (!id) return null;
	return get(meshProviders).find((p) => p.id === id) ?? null;
}

/** Whether mesh generation can run (enabled + a usable active provider). @returns {boolean} */
export function meshGenReady() {
	if (!get(meshGenEnabled)) return false;
	const cfg = activeMeshConfig();
	if (!cfg || !cfg.baseUrl) return false;
	if (cfg.kind === 'comfyui') return !!(cfg.workflowJson && cfg.workflowJson.trim());
	if (cfg.kind === 'meshy') return !!cfg.apiKey;
	return true;
}
