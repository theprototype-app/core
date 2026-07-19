// Meshy adapter (roadmap #11, G4) — reference HOSTED text-to-3D backend.
//
// Meshy v2 text-to-3d is two-phase: `preview` builds geometry, `refine` adds PBR
// textures using the preview task id. We expose both via the provider's `mode`:
//   mode 'preview' -> one task, untextured mesh (fast, cheap)
//   mode 'refine'  -> preview task, then a refine task (textured; more credits)
// The two phases are threaded through the `ref` handle so meshJobs stays generic.
//
// Auth: `Authorization: Bearer <MESHY_API_KEY>`. Note: the returned GLB is a signed
// URL on Meshy's CDN — if the browser blocks it for CORS, that surfaces as a network
// error in fetchResult; documented in docs/ai/generation.md.
// API docs: https://docs.meshy.ai — last checked 2026-07-19.

const TEXT_TO_3D = '/openapi/v2/text-to-3d';

/** @param {any} config @param {boolean} [json] */
function authHeaders(config, json) {
	/** @type {Record<string,string>} */
	const h = { Authorization: 'Bearer ' + (config.apiKey || '') };
	if (json) h['Content-Type'] = 'application/json';
	return h;
}

/** @param {any} config @param {any} body */
async function createTask(config, body) {
	const res = await fetch(config.baseUrl.replace(/\/+$/, '') + TEXT_TO_3D, {
		method: 'POST',
		headers: authHeaders(config, true),
		body: JSON.stringify(body)
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(describeError(res.status, text));
	}
	/** @type {any} */
	const json = await res.json().catch(() => ({}));
	const id = json.result || json.id;
	if (!id) throw new Error('Meshy did not return a task id');
	return id;
}

/**
 * @param {any} config
 * @param {{prompt: string, seed?: number}} params
 * @returns {Promise<{taskId: string, phase: string, mode: string}>}
 */
export async function submit(config, params) {
	if (!config.apiKey) throw new Error('Meshy needs an API key (set it in Settings)');
	const mode = config.mode === 'refine' ? 'refine' : 'preview';
	const id = await createTask(config, {
		mode: 'preview',
		prompt: params.prompt,
		art_style: config.artStyle || 'realistic',
		should_remesh: true
	});
	return { taskId: id, phase: 'preview', mode };
}

/**
 * @param {any} config
 * @param {{taskId: string, phase: string, mode: string}} ref
 * @returns {Promise<{status: string, progress?: number, error?: string, ref?: any, resultRef?: any}>}
 */
export async function poll(config, ref) {
	const res = await fetch(config.baseUrl.replace(/\/+$/, '') + TEXT_TO_3D + '/' + encodeURIComponent(ref.taskId), {
		headers: authHeaders(config, false)
	});
	if (!res.ok) {
		if (res.status === 404) return { status: 'running' }; // task not visible yet
		const text = await res.text().catch(() => '');
		return { status: 'error', error: describeError(res.status, text) };
	}
	/** @type {any} */
	const task = await res.json().catch(() => ({}));
	const st = String(task.status || '').toUpperCase();
	const progress = typeof task.progress === 'number' ? Math.max(0, Math.min(1, task.progress / 100)) : undefined;

	if (st === 'FAILED' || st === 'CANCELED') {
		return { status: 'error', error: (task.task_error && task.task_error.message) || 'Meshy task ' + st.toLowerCase() };
	}
	if (st === 'SUCCEEDED') {
		// preview done + refine requested -> kick off refine, keep polling the new task
		if (ref.phase === 'preview' && ref.mode === 'refine') {
			const refineId = await createTask(config, { mode: 'refine', preview_task_id: ref.taskId });
			return { status: 'running', progress: 0.5, ref: { taskId: refineId, phase: 'refine', mode: 'refine' } };
		}
		const glb = task.model_urls && (task.model_urls.glb || task.model_urls.gltf);
		if (!glb) return { status: 'error', error: 'Meshy task succeeded but returned no GLB url' };
		return { status: 'done', resultRef: { url: glb } };
	}
	return { status: 'running', progress };
}

/**
 * @param {any} config
 * @param {{url: string}} resultRef
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchResult(config, resultRef) {
	// signed CDN url — no auth header; may be CORS-restricted (see module header)
	const res = await fetch(resultRef.url);
	if (!res.ok) throw new Error('Downloading the Meshy GLB failed (' + res.status + ')');
	return await res.arrayBuffer();
}

/** @param {number} status @param {string} detail */
function describeError(status, detail) {
	if (status === 401 || status === 403) return 'Meshy rejected the API key';
	if (status === 402) return 'Meshy: out of credits';
	if (status === 429) return 'Meshy rate limit — try again shortly';
	let msg = '';
	try {
		const j = JSON.parse(detail);
		msg = j.message || j.error || '';
	} catch {
		msg = String(detail || '').slice(0, 150);
	}
	return 'Meshy error ' + status + (msg ? ': ' + msg : '');
}
