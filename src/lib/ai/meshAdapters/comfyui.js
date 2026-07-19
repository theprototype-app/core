// ComfyUI adapter (roadmap #11, G3) — the self-hosted TRELLIS path.
//
// The user builds a workflow in ComfyUI (text -> image -> TRELLIS -> SaveGLB) and
// exports it in **API format** (Settings gear -> "Save (API Format)", or dev-mode
// "Save (API)"). They paste that JSON into Settings with two placeholder tokens:
//   {{PROMPT}}  -> the text prompt (in the CLIP/text node's `text` field)
//   {{SEED}}    -> the sampler seed (a number field)
// We substitute the placeholders, POST the graph to /prompt, poll /history until the
// SaveGLB node emits a file, and download it from /view.
//
// ComfyUI has no built-in auth or CORS: launch it with
//   python main.py --enable-cors-header '*'
// and (for remote use) front it with TLS + a bearer token (any reverse proxy);
// set that token as the provider's API key and we send it as `Authorization: Bearer`.
//
// Verified against the ComfyUI HTTP API (POST /prompt, GET /history/{id},
// GET /view?filename=&subfolder=&type=). Last checked 2026-07-19.

/** @param {any} config @param {boolean} [json] */
function headers(config, json) {
	/** @type {Record<string,string>} */
	const h = {};
	if (json) h['Content-Type'] = 'application/json';
	if (config.apiKey) h['Authorization'] = 'Bearer ' + config.apiKey;
	return h;
}

/** Deep-substitute {{PROMPT}} / {{SEED}} in a parsed workflow graph. A value that is
 * EXACTLY "{{SEED}}" becomes the numeric seed; otherwise string replacement.
 * @param {any} node @param {string} prompt @param {number} seed @returns {any} */
function substitute(node, prompt, seed) {
	if (Array.isArray(node)) return node.map((v) => substitute(v, prompt, seed));
	if (node && typeof node === 'object') {
		/** @type {any} */
		const out = {};
		for (const k of Object.keys(node)) out[k] = substitute(node[k], prompt, seed);
		return out;
	}
	if (typeof node === 'string') {
		if (node === '{{SEED}}') return seed;
		return node.replace(/\{\{PROMPT\}\}/g, prompt).replace(/\{\{SEED\}\}/g, String(seed));
	}
	return node;
}

/**
 * @param {any} config
 * @param {{prompt: string, seed?: number, image?: any}} params
 * @returns {Promise<{promptId: string, clientId: string}>}
 */
export async function submit(config, params) {
	if (!config.workflowJson || !config.workflowJson.trim()) {
		throw new Error('This ComfyUI provider has no workflow JSON — paste an API-format workflow in Settings.');
	}
	let graph;
	try {
		graph = JSON.parse(config.workflowJson);
	} catch (e) {
		throw new Error('The saved ComfyUI workflow is not valid JSON — re-export it in API format.');
	}
	const seed = typeof params.seed === 'number' ? params.seed : Math.floor(Math.random() * 1e9);
	graph = substitute(graph, params.prompt, seed);

	const clientId = 'tpp-' + Math.random().toString(36).slice(2);
	const res = await fetch(config.baseUrl.replace(/\/+$/, '') + '/prompt', {
		method: 'POST',
		headers: headers(config, true),
		body: JSON.stringify({ prompt: graph, client_id: clientId })
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(describeError(res.status, body));
	}
	/** @type {any} */
	const json = await res.json().catch(() => ({}));
	if (json.node_errors && Object.keys(json.node_errors).length) {
		throw new Error('ComfyUI rejected the workflow: ' + JSON.stringify(json.node_errors).slice(0, 300));
	}
	if (!json.prompt_id) throw new Error('ComfyUI did not return a prompt_id');
	return { promptId: json.prompt_id, clientId };
}

/**
 * @param {any} config
 * @param {{promptId: string}} ref
 * @returns {Promise<{status: string, progress?: number, error?: string, resultRef?: any}>}
 */
export async function poll(config, ref) {
	const res = await fetch(config.baseUrl.replace(/\/+$/, '') + '/history/' + encodeURIComponent(ref.promptId), {
		headers: headers(config, false)
	});
	if (!res.ok) return { status: 'running' }; // transient — keep polling
	/** @type {any} */
	const json = await res.json().catch(() => ({}));
	const entry = json[ref.promptId];
	if (!entry) return { status: 'running' }; // still queued/executing

	const statusStr = entry.status && entry.status.status_str;
	if (statusStr === 'error') {
		return { status: 'error', error: extractError(entry) };
	}

	const found = findGlbOutput(entry.outputs, config.outputNodeId);
	if (found) return { status: 'done', resultRef: found };

	// completed with no GLB output is a workflow problem
	if (entry.status && entry.status.completed) {
		return { status: 'error', error: 'The workflow finished but produced no .glb output — check the SaveGLB node (or set the output node id in Settings).' };
	}
	return { status: 'running' };
}

/** @param {any} outputs @param {string} [preferNodeId] */
function findGlbOutput(outputs, preferNodeId) {
	if (!outputs || typeof outputs !== 'object') return null;
	const nodeIds = preferNodeId && outputs[preferNodeId] ? [preferNodeId] : Object.keys(outputs);
	for (const nodeId of nodeIds) {
		const out = outputs[nodeId];
		if (!out || typeof out !== 'object') continue;
		for (const key of Object.keys(out)) {
			const arr = out[key];
			if (!Array.isArray(arr)) continue;
			for (const f of arr) {
				const name = f && (f.filename || f.name);
				if (typeof name === 'string' && /\.(glb|gltf)$/i.test(name)) {
					return { filename: name, subfolder: f.subfolder || '', type: f.type || 'output' };
				}
			}
		}
	}
	return null;
}

/**
 * @param {any} config
 * @param {{filename: string, subfolder: string, type: string}} resultRef
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchResult(config, resultRef) {
	const q = new URLSearchParams({
		filename: resultRef.filename,
		subfolder: resultRef.subfolder || '',
		type: resultRef.type || 'output'
	});
	const res = await fetch(config.baseUrl.replace(/\/+$/, '') + '/view?' + q.toString(), {
		headers: headers(config, false)
	});
	if (!res.ok) throw new Error(describeError(res.status, 'downloading the generated GLB'));
	return await res.arrayBuffer();
}

/** @param {any} entry */
function extractError(entry) {
	try {
		const msgs = entry.status && entry.status.messages;
		if (Array.isArray(msgs)) {
			const err = msgs.find((m) => m[0] === 'execution_error');
			if (err && err[1]) return String(err[1].exception_message || err[1].node_type || 'execution error').slice(0, 300);
		}
	} catch {}
	return 'ComfyUI execution error';
}

/** @param {number} status @param {string} detail */
function describeError(status, detail) {
	if (status === 0) return 'Cannot reach ComfyUI — check the URL and that it runs with --enable-cors-header';
	if (status === 401 || status === 403) return 'ComfyUI proxy rejected the token (Authorization)';
	if (status === 404) return 'ComfyUI endpoint not found — check the base URL';
	return 'ComfyUI error ' + status + (detail ? ': ' + String(detail).slice(0, 200) : '');
}
