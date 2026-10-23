// 59 T4/T5 — the Tools & connections rows and features this build ships: chat providers + voice
// typing, mesh providers, desktop tools. Each row is DERIVED from the stores the old Settings ▸ AI
// sections already used — same stores, same storage keys, nothing migrates (the move is the page,
// not the data). Imported for its side effect by `toolLinks.js`, which every button that needs a
// tool reaches, so the registry is filled before anyone asks it.
//
// ENABLE / DISABLE per row, over the existing switches:
//   - a chat / mesh provider is ENABLED when it is the active one AND its master switch is on;
//     Enable = make it active + switch the master on, Disable = switch the master off (the
//     provider, its key and the active pointer stay)
//   - voice typing: the additive `enabled` field on its config (absent = on)
//   - a desktop tool: a LOCAL pref (`tools:blender`, default on) — off hides nothing in this lane;
//     the `editInBlender` feature reads it (59-replace's menu entry asks `featureStatus`)
// Test functions import their clients lazily, so this module adds nothing heavy to the boot graph.
import { writable, derived } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { registerToolRows, registerFeature } from './toolStatus.js';
import {
	aiProviders,
	aiActiveProvider,
	aiEnabled,
	setAiActiveProvider,
	setAiEnabled,
	aiReady
} from '../ai/providers.js';
import {
	meshProviders,
	meshActiveProvider,
	meshGenEnabled,
	setMeshActiveProvider,
	setMeshGenEnabled,
	meshGenReady
} from '../ai/meshProviders.js';
import { sttConfig, setSttConfig, sttReady, sttPresetFor } from '../ai/stt.js';

/** 'https://api.x.ai/v1' → 'api.x.ai' @param {string} url */
function hostOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return url || 'no URL';
	}
}

// ---- chat providers ---------------------------------------------------------------------------

/** @param {any} p */
const chatConfigured = (p) => !!(p.baseUrl && p.model);

/** @type {import('svelte/store').Readable<import('./toolStatus.js').ToolRow[]>} */
const chatRows = derived([aiProviders, aiActiveProvider, aiEnabled], ([list, active, on]) =>
	list.map((p) => {
		const inUse = on && active === p.id;
		const configured = chatConfigured(p);
		return {
			id: 'chat:' + p.id,
			section: 'chat',
			label: p.label || 'Chat provider',
			detail: (p.model || 'no model') + ' · ' + hostOf(p.baseUrl),
			state: /** @type {import('./toolStatus.js').ToolState} */ (
				!configured ? 'setup' : inUse ? 'ready' : 'off'
			),
			stateText: !configured
				? 'Needs a base URL and a model'
				: inUse
					? 'In use'
					: active === p.id
						? 'Assistant switched off'
						: 'Not in use',
			features: ['AI assistant', 'Quick prompt bar', ...(p.physicsTools ? ['Physics tools'] : [])],
			enabled: inUse,
			setEnabled: (/** @type {boolean} */ yes) => {
				if (yes) {
					setAiActiveProvider(p.id);
					setAiEnabled(true);
				} else setAiEnabled(false);
			},
			test: async () => {
				const { testConnection } = await import('../ai/client.js');
				const r = await testConnection(p);
				if (r.ok && r.modelOk === false)
					return {
						ok: false,
						detail: r.detail + ' — but the model “' + p.model + '” did not answer'
					};
				return { ok: r.ok, detail: r.detail };
			},
			form: { kind: 'chat', ref: p }
		};
	})
);

/** voice typing is one server, so one row (it lives under Chat: it is how you talk to the assistant) */
const voiceRow = derived(sttConfig, (cfg) => {
	const preset = sttPresetFor(cfg.preset);
	const ready = sttReady(cfg);
	const off = cfg.enabled === false;
	const missing =
		!cfg.baseUrl || !cfg.model
			? 'Needs a base URL and a model'
			: preset.needsKey && !cfg.apiKey
				? 'Needs an API key'
				: '';
	return [
		{
			id: 'chat:voice',
			section: 'chat',
			label: 'Voice typing',
			detail:
				(preset.preset === 'custom' ? 'Self-hosted' : preset.label) + ' · ' + hostOf(cfg.baseUrl),
			state: /** @type {import('./toolStatus.js').ToolState} */ (
				ready ? 'ready' : off && !missing ? 'off' : 'setup'
			),
			stateText: ready ? 'In use' : off ? 'Switched off' : missing,
			features: ['The assistant’s mic', 'Talk in VR'],
			enabled: !off,
			setEnabled: (/** @type {boolean} */ yes) => void setSttConfig({ enabled: yes }),
			test: async () => {
				const { transcribe, describeSttError, silentWav } = await import('../ai/stt.js');
				try {
					await transcribe(silentWav());
					return { ok: true, detail: 'Connected — the server accepted a recording' };
				} catch (error) {
					return { ok: false, detail: describeSttError(error) };
				}
			},
			form: { kind: 'voice' }
		}
	];
});

registerToolRows('chat', chatRows, { add: { label: 'Add chat provider', form: 'chat' } });
registerToolRows('chat', voiceRow);

// ---- mesh providers ---------------------------------------------------------------------------

/** the meshGenReady rule for ONE provider @param {any} p */
function meshConfigured(p) {
	if (!p.baseUrl) return 'Needs a URL';
	if (p.kind === 'comfyui' && !(p.workflowJson && p.workflowJson.trim()))
		return 'Needs a ComfyUI workflow';
	if (p.kind === 'meshy' && !p.apiKey) return 'Needs an API key';
	return '';
}

const meshRows = derived(
	[meshProviders, meshActiveProvider, meshGenEnabled],
	([list, active, on]) =>
		list.map((p) => {
			const inUse = on && active === p.id;
			const missing = meshConfigured(p);
			return {
				id: 'mesh:' + p.id,
				section: 'mesh',
				label: p.label || 'Mesh provider',
				detail: (p.kind === 'meshy' ? 'Meshy' : 'ComfyUI') + ' · ' + hostOf(p.baseUrl),
				state: /** @type {import('./toolStatus.js').ToolState} */ (
					missing ? 'setup' : inUse ? 'ready' : 'off'
				),
				stateText:
					missing ||
					(inUse ? 'In use' : active === p.id ? 'Mesh generation switched off' : 'Not in use'),
				features: ['Generate 3D model (Add menu)', 'generate_mesh for the assistant'],
				enabled: inUse,
				setEnabled: (/** @type {boolean} */ yes) => {
					if (yes) {
						setMeshActiveProvider(p.id);
						setMeshGenEnabled(true);
					} else setMeshGenEnabled(false);
				},
				test: async () => (await import('../ai/meshTest.js')).testMeshProvider(p),
				form: { kind: 'mesh', ref: p }
			};
		})
);
registerToolRows('mesh', meshRows, { add: { label: 'Add mesh provider', form: 'mesh' } });

// ---- desktop tools ----------------------------------------------------------------------------

const BLENDER_KEY = 'tools:blender';
/** LOCAL: Desktop tools ▸ Blender (the manual round trip) is on — default on, nothing to install */
export const blenderEnabled = writable(safeStorage.getItem(BLENDER_KEY) !== 'false');
/** @param {boolean} on */
export function setBlenderEnabled(on) {
	blenderEnabled.set(!!on);
	if (on) safeStorage.removeItem(BLENDER_KEY);
	else safeStorage.setItem(BLENDER_KEY, 'false');
}

/** can this browser keep a handle on a saved file (59 T7a watch)? Chromium desktop only */
function canWatchFiles() {
	return (
		typeof window !== 'undefined' &&
		typeof (/** @type {any} */ (window).showSaveFilePicker) === 'function'
	);
}

const desktopRows = derived(blenderEnabled, (on) => [
	{
		id: 'desktop:blender',
		section: 'desktop',
		label: 'Blender and other 3D tools',
		detail: 'Maya, 3ds Max, Cascadeur … anything that opens and saves glTF',
		state: /** @type {import('./toolStatus.js').ToolState} */ (on ? 'ready' : 'off'),
		stateText: on ? 'Nothing to install' : 'Switched off',
		features: ['Edit in Blender…', 'Drop the file back to replace the model'],
		enabled: on,
		setEnabled: setBlenderEnabled,
		test: async () => ({
			ok: true,
			detail: canWatchFiles()
				? 'Ready — this browser can also watch the saved file and offer Reload'
				: 'Ready — drop the saved file back onto the object (this browser cannot watch files)'
		}),
		form: { kind: 'desktop' }
	}
]);
registerToolRows('desktop', desktopRows);

// ---- features (T5) ----------------------------------------------------------------------------

registerFeature({
	id: 'assistant',
	label: 'The AI assistant',
	section: 'chat',
	needs: 'a Chat provider',
	ready: derived([aiEnabled, aiProviders, aiActiveProvider], () => aiReady()),
	row: () => {
		let id = null;
		aiActiveProvider.subscribe((v) => (id = v))();
		return id ? 'chat:' + id : null;
	}
});
registerFeature({
	id: 'voiceTyping',
	label: 'Voice typing',
	section: 'chat',
	needs: 'a voice typing server',
	ready: derived(sttConfig, (cfg) => sttReady(cfg)),
	row: () => 'chat:voice'
});
registerFeature({
	id: 'generateMesh',
	label: 'Generate 3D model',
	section: 'mesh',
	needs: 'a Mesh provider',
	ready: derived([meshGenEnabled, meshProviders, meshActiveProvider], () => meshGenReady()),
	row: () => {
		let id = null;
		meshActiveProvider.subscribe((v) => (id = v))();
		return id ? 'mesh:' + id : null;
	}
});
registerFeature({
	id: 'editInBlender',
	label: 'Edit in Blender',
	section: 'desktop',
	needs: 'Desktop tools ▸ Blender',
	fix: 'switch it on',
	ready: blenderEnabled,
	row: () => 'desktop:blender'
});
