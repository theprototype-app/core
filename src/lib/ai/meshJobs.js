import { writable, get } from 'svelte/store';
import { showToast } from '../../stores/appStore.js';
import { activeMeshConfig, meshProviders, meshGenReady } from './meshProviders.js';
import { adapterFor } from './meshAdapters/index.js';
import { importGeneratedGlb } from '$lib/fileHandler.svelte';
import { showChoiceEx } from '$lib/confirmDialog';
import { pictureConsentFor, namedError } from './meshConsent.js'; // 73 AI7 + AI4: a leaf
import { safeStorage } from '$lib/safeStorage';

// Mesh-generation job runner (roadmap #11, G2/G5). Submits a prompt to the active
// mesh provider, polls to completion, downloads the GLB, and imports it into the
// scene (placement + replication + undo via fileHandler). Jobs run async; progress
// surfaces through the meshJobs store (rendered as a Toasts card).
//
// uir-timeline — THE GENERATE WINDOW'S MEMORY. The job list and the prompt history are saved on this
// device (`meshGen:jobs`, `meshGen:history`; never the picture, never the API key), so both survive a
// reload. A job that was RUNNING when the page went away RESUMES: its provider task is polled again by
// the saved `ref` instead of being sent again, because a resubmission is a second charge. Two tabs share
// the one list (the `storage` event) and only one of them runs a job: the runner stamps `beat` on every
// poll, and another tab claims the job only once that stamp is STALE_MS old (its owner reloaded or
// closed). A job still `submitting` when the page went away cannot be resumed (no provider task id came
// back yet), so it is marked failed with the reason and offered again.

/**
 * @typedef {Object} MeshJob
 * @property {string} id
 * @property {string} prompt
 * @property {string} provider     provider label
 * @property {'submitting'|'running'|'importing'|'done'|'error'|'cancelled'} status
 * @property {number|null} progress  0..1 or null (indeterminate)
 * @property {string} [error]
 * @property {string} [uuid]        placed object uuid when done
 * @property {string} [providerId]  uir-timeline: the provider config it ran on (resume, retry)
 * @property {string} [name]        the object name asked for
 * @property {number[]} [position]  where it is placed
 * @property {number} [seed]
 * @property {number} [at]          when it was started
 * @property {any} [ref]            the provider's task handle (JSON) while running: what a resume polls
 * @property {any} [resultRef]      the finished task's result handle (an import that was interrupted)
 * @property {string} [hash]        the result's content hash in the Explorer "Generated" folder (Reopen)
 * @property {boolean} [image]      started from a picture (the picture itself is never kept)
 * @property {string} [tab]         the tab running it
 * @property {number} [beat]        the runner's last poll (Date.now())
 * @property {boolean} [cardHidden] the toast card no longer shows it (the Generate window still does)
 */

const POLL_MS = 3000;
const MAX_MS = 10 * 60 * 1000; // 10 min cap
const MAX_GLB_BYTES = 40 * 1024 * 1024; // 40 MB sanity cap

const JOBS_KEY = 'meshGen:jobs';
const HISTORY_KEY = 'meshGen:history';
/** how many finished jobs / history prompts are kept */
const KEEP_JOBS = 40;
const KEEP_HISTORY = 30;
/** a running job's owner is gone once its beat is this old (it beats every POLL_MS) */
export const STALE_MS = 12000;
const RUNNING = new Set(['submitting', 'running', 'importing']);

function newId() {
	try {
		if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
	} catch {}
	return 'mj-' + Math.random().toString(36).slice(2);
}
/** this tab, for the running-job claim */
const TAB = newId();
/** jobs this tab is running right now @type {Set<string>} */
const runningHere = new Set();

/** @param {string} key @returns {any[]} */
function readList(key) {
	try {
		const v = JSON.parse(safeStorage.getItem(key) ?? '[]');
		return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [];
	} catch {
		return [];
	}
}

/** what is saved of a job: the fields above, the card flag off (a reload starts with a quiet card) @param {MeshJob} j */
function saved(j) {
	const { cardHidden, ...rest } = j;
	void cardHidden;
	return rest;
}

/**
 * The jobs saved by an earlier page. A finished one comes back for the window only (its card was seen
 * already); a running one comes back to be RESUMED by whichever tab claims it; one that never got a
 * provider task id can only be offered again.
 * @returns {MeshJob[]}
 */
function loadJobs() {
	if (typeof localStorage === 'undefined') return [];
	return readList(JOBS_KEY).map((/** @type {MeshJob} */ j) => {
		if (j.status === 'submitting' && j.tab === TAB) return j;
		if (j.status === 'submitting' && (!j.beat || Date.now() - j.beat > STALE_MS))
			return { ...j, status: 'error', error: 'The page reloaded before the provider took the job. Nothing ran; generate it again.', cardHidden: true };
		return RUNNING.has(j.status) ? j : { ...j, cardHidden: true };
	});
}

/** @type {import('svelte/store').Writable<MeshJob[]>} */
export const meshJobs = writable(loadJobs());

/** ids this tab dismissed: a merge from another tab's write must not bring them back */
const dropped = new Set();
let lastWritten = '';
meshJobs.subscribe((list) => {
	if (typeof localStorage === 'undefined') return;
	const mine = new Set(list.map((j) => j.id));
	// another tab's jobs we have not seen yet stay in the saved list (one list for every tab)
	const others = readList(JOBS_KEY).filter((j) => !mine.has(j.id) && !dropped.has(j.id));
	const keep = trimJobs([...others, ...list.map(saved)]);
	const text = JSON.stringify(keep);
	if (text === lastWritten) return;
	lastWritten = text;
	safeStorage.setItem(JOBS_KEY, text);
});

/** newest KEEP_JOBS finished ones + every running one, oldest first @param {MeshJob[]} list */
function trimJobs(list) {
	const done = list.filter((j) => !RUNNING.has(j.status));
	const cut = new Set(done.slice(0, Math.max(0, done.length - KEEP_JOBS)).map((j) => j.id));
	return list.filter((j) => !cut.has(j.id));
}

/** @param {string} id @param {Partial<MeshJob>} patch */
function update(id, patch) {
	meshJobs.update((list) => list.map((j) => (j.id === id ? { ...j, ...patch } : j)));
}

/** @param {MeshJob} job */
function add(job) {
	meshJobs.update((list) => [...list, job]);
}

/** Remove a finished/cancelled job (the Generate window's ✕ and Clear finished). @param {string} id */
export function dismissMeshJob(id) {
	dropped.add(id);
	meshJobs.update((list) => list.filter((j) => j.id !== id));
}

/** The toast card lets go of a job; the Generate window keeps it. @param {string} id */
export function hideMeshJobCard(id) {
	update(id, { cardHidden: true });
}

/** Every finished, failed and cancelled job leaves the list. */
export function clearFinishedMeshJobs() {
	for (const j of get(meshJobs)) if (!RUNNING.has(j.status)) dropped.add(j.id);
	meshJobs.update((list) => list.filter((j) => RUNNING.has(j.status)));
}

/** @param {string} id */
export function cancelMeshJob(id) {
	cancelled.add(id);
	update(id, { status: 'cancelled', ref: undefined });
}

/** @type {Set<string>} */
const cancelled = new Set();

// ---- the prompt history -----------------------------------------------------------------

/**
 * @typedef {{prompt: string, name?: string, at: number, provider?: string}} MeshPrompt
 */
/** the prompts this device asked for, newest FIRST; a repeated prompt moves to the top @type {import('svelte/store').Writable<MeshPrompt[]>} */
export const meshPromptHistory = writable(
	typeof localStorage === 'undefined'
		? []
		: readList(HISTORY_KEY).filter((/** @type {any} */ e) => typeof e.prompt === 'string' && e.prompt.trim())
);
meshPromptHistory.subscribe((list) => {
	if (typeof localStorage !== 'undefined') safeStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, KEEP_HISTORY)));
});

/** @param {string} prompt @param {{name?: string, provider?: string}} [extra] */
export function rememberMeshPrompt(prompt, extra = {}) {
	const text = (prompt || '').trim();
	if (!text) return;
	meshPromptHistory.update((list) => [
		{ prompt: text, ...(extra.name ? { name: extra.name } : {}), ...(extra.provider ? { provider: extra.provider } : {}), at: Date.now() },
		...list.filter((e) => e.prompt !== text)
	].slice(0, KEEP_HISTORY));
}

/** @param {string} prompt */
export function forgetMeshPrompt(prompt) {
	meshPromptHistory.update((list) => list.filter((e) => e.prompt !== prompt));
}

export function clearMeshPromptHistory() {
	meshPromptHistory.set([]);
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} prompt */
function shortName(prompt) {
	const s = (prompt || 'Generated').trim().replace(/\s+/g, ' ');
	return s.length > 40 ? s.slice(0, 40) : s;
}

/**
 * Generate a mesh from a prompt and/or a picture and place it in the scene. Roadmap 73 AI1: `image` is
 * an attachments.prepareImage result (downscaled, metadata stripped). The picture and its FILE NAME stay
 * off the scene: the provenance says only that one was used, and the default object name is generic.
 * @param {{prompt?: string, providerId?: string, seed?: number, name?: string, position?: number[], image?: {mimeType: string, data: string, name?: string}}} params
 * @returns {Promise<{uuid: string}>}
 */
export async function generateMesh(params) {
	const prompt = (params.prompt || '').trim();
	const image = params.image ?? null;
	if (!prompt && !image) throw new Error('Empty prompt');

	const cfg = params.providerId
		? get(meshProviders).find((p) => p.id === params.providerId)
		: activeMeshConfig();
	if (!cfg) {
		showToast('Configure a mesh-generation provider in Settings');
		throw new Error('no mesh provider');
	}
	if (!params.providerId && !meshGenReady()) {
		showToast('The active mesh provider is not fully set up — Settings ▸ Tools & connections ▸ Mesh providers');
		throw new Error('mesh provider not ready');
	}

	// 73 AI7: a picture going to a HOSTED provider (a third party) is asked about first: what it costs and
	// where it goes. Every path reaches here (the dialog, the assistant's from_picture), so none skips it.
	// Cancel sends nothing and leaves no job row.
	if (image && !(await askPictureConsent(cfg))) throw new CancelledError();

	const id = newId();
	const seed = typeof params.seed === 'number' ? params.seed : Math.floor(Math.random() * 1e9);
	rememberMeshPrompt(prompt, { name: params.name, provider: cfg.label });
	add({
		id,
		prompt: prompt || 'From a picture',
		provider: cfg.label,
		providerId: cfg.id,
		status: 'submitting',
		progress: null,
		at: Date.now(),
		seed,
		tab: TAB,
		beat: Date.now(),
		...(params.name ? { name: params.name } : {}),
		...(params.position ? { position: [...params.position] } : {}),
		...(image ? { image: true } : {})
	});

	const adapter = adapterFor(cfg.kind);
	/** @type {any} */
	let ref;
	try {
		ref = await adapter.submit(cfg, { prompt, seed, ...(image ? { image } : {}) });
	} catch (e) {
		cancelled.delete(id);
		fail(id, e, cfg);
		throw e;
	}
	if (cancelled.has(id)) {
		// cancelled while the provider was taking it: the task exists there, but nothing here waits for it
		cancelled.delete(id);
		throw new CancelledError();
	}
	update(id, { status: 'running', progress: null, ref, beat: Date.now() });
	return runJob(id, cfg, ref, Date.now());
}

/**
 * Poll a submitted job to the end, import the result, cache it in the Explorer. The second half of
 * generateMesh, and ALL of a resumed job (uir-timeline): `ref` is the provider's task handle.
 * @param {string} id @param {any} cfg @param {any} ref @param {number} start
 * @param {any} [resultRef] a finished task's result: skip the polling (an import that was interrupted)
 * @returns {Promise<{uuid: string}>}
 */
async function runJob(id, cfg, ref, start, resultRef = null) {
	const adapter = adapterFor(cfg.kind);
	runningHere.add(id);
	try {
		while (!resultRef) {
			if (cancelled.has(id)) throw new CancelledError();
			await sleep(POLL_MS);
			if (cancelled.has(id)) throw new CancelledError();
			if (Date.now() - start > MAX_MS) throw new Error(cfg.label + ' did not finish within 10 minutes — try again, or try Preview mode, which is quicker');

			/** @type {any} */
			let r;
			try {
				r = await adapter.poll(cfg, ref);
			} catch (e) {
				// transient network blips shouldn't kill a long job — keep polling
				update(id, { beat: Date.now() });
				continue;
			}
			if (cancelled.has(id)) throw new CancelledError();
			if (r.ref) ref = r.ref;
			update(id, { beat: Date.now(), ref, ...(typeof r.progress === 'number' ? { progress: r.progress } : {}) });
			if (r.status === 'done') {
				resultRef = r.resultRef;
				break;
			}
			if (r.status === 'error') throw new Error(r.error || 'generation failed');
		}

		update(id, { status: 'importing', progress: 1, resultRef, beat: Date.now() });
		const buffer = await adapter.fetchResult(cfg, resultRef);
		if (buffer.byteLength > MAX_GLB_BYTES) {
			throw new Error('Generated mesh is too large (' + Math.round(buffer.byteLength / 1e6) + ' MB, cap 40 MB)');
		}

		const job = get(meshJobs).find((j) => j.id === id);
		const prompt = job?.image && job.prompt === 'From a picture' ? '' : (job?.prompt ?? '');
		const provenance = { prompt, provider: cfg.kind, label: cfg.label, seed: job?.seed, at: Date.now(), ...(job?.image ? { source: 'image' } : {}) };
		const objectName = job?.name || (prompt ? shortName(prompt) : 'Model from a picture');
		const uuid = await importGeneratedGlb(buffer, {
			name: objectName,
			position: job?.position,
			provenance
		});

		// best-effort cache into the Explorer "Generated" library for re-placement (and the window's Reopen)
		const hash = await hashOf(buffer);
		cacheGenerated(buffer, objectName).catch(() => {});

		update(id, { status: 'done', progress: 1, uuid, ...(hash ? { hash } : {}), ref: undefined, resultRef: undefined });
		return { uuid };
	} catch (e) {
		if (e instanceof CancelledError) {
			update(id, { status: 'cancelled', ref: undefined, resultRef: undefined });
			throw e;
		}
		fail(id, e, cfg);
		throw e;
	} finally {
		cancelled.delete(id);
		runningHere.delete(id);
	}
}

/** @param {string} id @param {any} e @param {any} cfg */
function fail(id, e, cfg) {
	const msg = namedError(e instanceof Error ? e.message : String(e), cfg);
	update(id, { status: 'error', error: msg, ref: undefined, resultRef: undefined });
	showToast('Mesh generation failed: ' + msg);
}

/** @param {ArrayBuffer} buffer @returns {Promise<string|null>} */
async function hashOf(buffer) {
	try {
		const explorer = await import('$lib/explorer');
		return await explorer.hashBytes(buffer);
	} catch {
		return null;
	}
}

// ---- resume + the cross-tab claim (uir-timeline) -----------------------------------------

/**
 * Take over the running jobs nobody runs any more (this page's previous life, or a closed tab) and
 * poll them on. A job keeps its provider task: nothing is sent again, so nothing is charged again.
 * Called on a timer while any job is running; also the test seam (`meshJobs.resumeMeshJobs()`).
 * @returns {string[]} the ids this call took over
 */
export function resumeMeshJobs() {
	/** @type {string[]} */
	const took = [];
	const fresh = new Map(readList(JOBS_KEY).map((j) => [j.id, j]));
	for (const j of get(meshJobs)) {
		if (!RUNNING.has(j.status) || runningHere.has(j.id) || j.status === 'submitting') continue;
		// the saved copy is the truth about the owner's heartbeat: another tab writes it there
		const beat = Math.max(j.beat ?? 0, fresh.get(j.id)?.beat ?? 0);
		const owner = fresh.get(j.id)?.tab ?? j.tab;
		// this tab's own job is being run by generateMesh; another tab's is theirs while it beats
		if (owner === TAB) continue;
		if (owner && Date.now() - beat < STALE_MS) continue;
		const cfg = get(meshProviders).find((p) => p.id === j.providerId);
		if (!cfg || (!j.ref && !j.resultRef)) {
			update(j.id, { status: 'error', error: 'This job cannot be picked up again (its provider was removed). Generate it again.', ref: undefined });
			continue;
		}
		update(j.id, { tab: TAB, beat: Date.now() });
		took.push(j.id);
		runJob(j.id, cfg, j.ref, j.at ?? Date.now(), j.resultRef ?? null).catch(() => {});
	}
	return took;
}

if (typeof window !== 'undefined') {
	// one list for every tab of this browser: another tab's write brings its jobs (and their states) here
	window.addEventListener('storage', (e) => {
		if (e.key !== JOBS_KEY) return;
		const theirs = readList(JOBS_KEY);
		meshJobs.update((list) => {
			const byId = new Map(list.map((j) => [j.id, j]));
			for (const t of theirs) {
				if (dropped.has(t.id)) continue;
				// the job runs HERE: only a Cancel pressed in the other tab is news
				if (runningHere.has(t.id)) {
					if (t.status === 'cancelled') queueMicrotask(() => cancelMeshJob(t.id));
					continue;
				}
				byId.set(t.id, { ...t, cardHidden: byId.get(t.id)?.cardHidden ?? true });
			}
			return [...byId.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
		});
	});
	// the watch: while some job is running and nobody here runs it, look every few seconds
	setInterval(() => {
		if (get(meshJobs).some((j) => RUNNING.has(j.status) && !runningHere.has(j.id))) resumeMeshJobs();
	}, 4000);
}

/**
 * Reopen a finished job's model: the object if it is still in the scene (selected and framed), else the
 * cached file from the Explorer's "Generated" folder, placed again through the same import (one undo,
 * provenance kept). @param {string} id @returns {Promise<'shown'|'placed'|'missing'>}
 */
export async function reopenMeshJob(id) {
	const job = get(meshJobs).find((j) => j.id === id);
	if (!job || job.status !== 'done') return 'missing';
	const [{ objectsGroup }, objectActions] = await Promise.all([import('../../stores/sceneStore'), import('$lib/objectActions')]);
	/** @type {any} */
	const group = get(objectsGroup);
	if (job.uuid && group?.getObjectByProperty?.('uuid', job.uuid)) {
		objectActions.selectObject(job.uuid);
		objectActions.focusObject(job.uuid);
		return 'shown';
	}
	const explorer = await import('$lib/explorer');
	const item = job.hash ? explorer.itemByHash(job.hash) : null;
	const blob = item ? await explorer.itemBlob(item.id) : null;
	if (!blob) {
		showToast('The model is no longer in the scene or in Explorer ▸ Generated');
		return 'missing';
	}
	const prompt = job.image && job.prompt === 'From a picture' ? '' : job.prompt;
	const uuid = await importGeneratedGlb(await blob.arrayBuffer(), {
		name: job.name || (prompt ? shortName(prompt) : 'Model from a picture'),
		provenance: { prompt, provider: job.providerId ?? '', label: job.provider, seed: job.seed, at: Date.now(), ...(job.image ? { source: 'image' } : {}) }
	});
	update(id, { uuid });
	return 'placed';
}

/** @param {any} cfg @returns {Promise<boolean>} */
async function askPictureConsent(cfg) {
	const ask = pictureConsentFor(cfg);
	if (!ask) return true;
	const answer = await showChoiceEx({
		id: 'mesh-picture-consent',
		title: ask.title,
		message: ask.message,
		link: ask.link,
		choices: [{ value: 'send', label: ask.send }]
	});
	return answer?.value === 'send';
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
