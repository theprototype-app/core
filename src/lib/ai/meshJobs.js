import { writable, get } from 'svelte/store';
import { showToast } from '../../stores/appStore.js';
import { activeMeshConfig, meshProviders, meshGenReady } from './meshProviders.js';
import { adapterFor } from './meshAdapters/index.js';
import { importGeneratedGlb } from '$lib/fileHandler.svelte';

// Mesh-generation job runner (roadmap #11, G2/G5). Submits a prompt to the active
// mesh provider, polls to completion, downloads the GLB, and imports it into the
// scene (placement + replication + undo via fileHandler). Jobs run async; progress
// surfaces through the meshJobs store (rendered as a Toasts card).

/**
 * @typedef {Object} MeshJob
 * @property {string} id
 * @property {string} prompt
 * @property {string} provider     provider label
 * @property {'submitting'|'running'|'importing'|'done'|'error'|'cancelled'} status
 * @property {number|null} progress  0..1 or null (indeterminate)
 * @property {string} [error]
 * @property {string} [uuid]        placed object uuid when done
 */

/** @type {import('svelte/store').Writable<MeshJob[]>} */
export const meshJobs = writable([]);

const POLL_MS = 3000;
const MAX_MS = 10 * 60 * 1000; // 10 min cap
const MAX_GLB_BYTES = 40 * 1024 * 1024; // 40 MB sanity cap

/** @type {Set<string>} */
const cancelled = new Set();

/** @param {string} id @param {Partial<MeshJob>} patch */
function update(id, patch) {
	meshJobs.update((list) => list.map((j) => (j.id === id ? { ...j, ...patch } : j)));
}

/** @param {MeshJob} job */
function add(job) {
	meshJobs.update((list) => [...list, job]);
}

/** Remove finished/cancelled jobs from the card. @param {string} id */
export function dismissMeshJob(id) {
	meshJobs.update((list) => list.filter((j) => j.id !== id));
}

/** @param {string} id */
export function cancelMeshJob(id) {
	cancelled.add(id);
	update(id, { status: 'cancelled' });
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} prompt */
function shortName(prompt) {
	const s = (prompt || 'Generated').trim().replace(/\s+/g, ' ');
	return s.length > 40 ? s.slice(0, 40) : s;
}

function newId() {
	try {
		if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
	} catch {}
	return 'mj-' + Math.random().toString(36).slice(2);
}

/**
 * Generate a mesh from a prompt and place it in the scene.
 * @param {{prompt: string, providerId?: string, seed?: number, name?: string, position?: number[]}} params
 * @returns {Promise<{uuid: string}>}
 */
export async function generateMesh(params) {
	const prompt = (params.prompt || '').trim();
	if (!prompt) throw new Error('Empty prompt');

	const cfg = params.providerId
		? get(meshProviders).find((p) => p.id === params.providerId)
		: activeMeshConfig();
	if (!cfg) {
		showToast('Configure a mesh-generation provider in Settings');
		throw new Error('no mesh provider');
	}
	if (!params.providerId && !meshGenReady()) {
		showToast('The active mesh provider is not fully configured (Settings -> AI)');
		throw new Error('mesh provider not ready');
	}

	const id = newId();
	const seed = typeof params.seed === 'number' ? params.seed : Math.floor(Math.random() * 1e9);
	add({ id, prompt, provider: cfg.label, status: 'submitting', progress: null });

	const adapter = adapterFor(cfg.kind);
	const start = Date.now();
	try {
		let ref = await adapter.submit(cfg, { prompt, seed });
		update(id, { status: 'running', progress: null });

		/** @type {any} */
		let resultRef = null;
		for (;;) {
			if (cancelled.has(id)) throw new CancelledError();
			await sleep(POLL_MS);
			if (cancelled.has(id)) throw new CancelledError();
			if (Date.now() - start > MAX_MS) throw new Error('Generation timed out after 10 minutes');

			/** @type {any} */
			let r;
			try {
				r = await adapter.poll(cfg, ref);
			} catch (e) {
				// transient network blips shouldn't kill a long job — keep polling
				continue;
			}
			if (r.ref) ref = r.ref;
			if (typeof r.progress === 'number') update(id, { progress: r.progress });
			if (r.status === 'done') {
				resultRef = r.resultRef;
				break;
			}
			if (r.status === 'error') throw new Error(r.error || 'generation failed');
		}

		update(id, { status: 'importing', progress: 1 });
		const buffer = await adapter.fetchResult(cfg, resultRef);
		if (buffer.byteLength > MAX_GLB_BYTES) {
			throw new Error('Generated mesh is too large (' + Math.round(buffer.byteLength / 1e6) + ' MB, cap 40 MB)');
		}

		const provenance = { prompt, provider: cfg.kind, label: cfg.label, seed, at: Date.now() };
		const uuid = await importGeneratedGlb(buffer, {
			name: params.name || shortName(prompt),
			position: params.position,
			provenance
		});

		// best-effort cache into the Explorer "Generated" library for re-placement
		cacheGenerated(buffer, params.name || shortName(prompt)).catch(() => {});

		update(id, { status: 'done', progress: 1, uuid });
		return { uuid };
	} catch (e) {
		cancelled.delete(id);
		if (e instanceof CancelledError) {
			update(id, { status: 'cancelled' });
			throw e;
		}
		const msg = e instanceof Error ? e.message : String(e);
		update(id, { status: 'error', error: msg });
		showToast('Mesh generation failed: ' + msg);
		throw e;
	} finally {
		cancelled.delete(id);
	}
}

class CancelledError extends Error {
	constructor() {
		super('cancelled');
		this.name = 'CancelledError';
	}
}

/** Save a generated GLB into the Explorer "Generated" folder (best-effort).
 * @param {ArrayBuffer} buffer @param {string} name */
async function cacheGenerated(buffer, name) {
	try {
		const explorer = await import('$lib/explorer');
		const folders = get(explorer.explorerFolders);
		/** @type {any} */
		let folder = folders.find((/** @type {any} */ f) => f.name === 'Generated' && !f.parentId);
		if (!folder) folder = explorer.createFolder('Generated', null);
		const file = new File([buffer], (name || 'generated') + '.glb', { type: 'model/gltf-binary' });
		await explorer.importFiles([file], folder ? folder.id : null);
	} catch {
		// Explorer is optional; ignore caching failures
	}
}
