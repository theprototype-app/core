// Node-side mesh generation for the console agent (roadmap #11, G8). A compact port
// of the in-app ComfyUI + Meshy adapters: submit a prompt, poll to completion,
// return the GLB bytes. The agent then pushes them to the session via the
// `objectfile` raw-bytes message (it can't run three.js). Node 18+ global fetch.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {any} node @param {string} prompt @param {number} seed @returns {any} */
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

/** @param {any} outputs @param {string} [prefer] */
function findGlb(outputs, prefer) {
	if (!outputs) return null;
	const ids = prefer && outputs[prefer] ? [prefer] : Object.keys(outputs);
	for (const id of ids) {
		const out = outputs[id];
		if (!out || typeof out !== 'object') continue;
		for (const key of Object.keys(out)) {
			const arr = out[key];
			if (!Array.isArray(arr)) continue;
			for (const f of arr) {
				const name = f && (f.filename || f.name);
				if (typeof name === 'string' && /\.(glb|gltf)$/i.test(name))
					return { filename: name, subfolder: f.subfolder || '', type: f.type || 'output' };
			}
		}
	}
	return null;
}

/**
 * @param {any} config {kind, baseUrl, apiKey, workflowJson, outputNodeId, mode}
 * @param {string} prompt
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{bytes: Uint8Array}>}
 */
export async function generateMesh(config, prompt, log = () => {}) {
	const base = config.baseUrl.replace(/\/+$/, '');
	const seed = Math.floor(Math.random() * 1e9);
	const deadline = Date.now() + 10 * 60 * 1000;

	if (config.kind === 'comfyui') {
		let graph = JSON.parse(config.workflowJson);
		graph = substitute(graph, prompt, seed);
		const headers = { 'Content-Type': 'application/json' };
		if (config.apiKey) headers['Authorization'] = 'Bearer ' + config.apiKey;
		const res = await fetch(base + '/prompt', {
			method: 'POST',
			headers,
			body: JSON.stringify({ prompt: graph, client_id: 'agt-' + seed })
		});
		if (!res.ok) throw new Error('ComfyUI /prompt ' + res.status);
		const j = await res.json();
		if (!j.prompt_id) throw new Error('ComfyUI returned no prompt_id');
		log('comfyui job ' + j.prompt_id);
		for (;;) {
			if (Date.now() > deadline) throw new Error('generation timed out');
			await sleep(3000);
			const hres = await fetch(base + '/history/' + encodeURIComponent(j.prompt_id), { headers: authOnly(config) });
			if (!hres.ok) continue;
			const hist = await hres.json();
			const entry = hist[j.prompt_id];
			if (!entry) continue;
			if (entry.status && entry.status.status_str === 'error') throw new Error('ComfyUI execution error');
			const ref = findGlb(entry.outputs, config.outputNodeId);
			if (ref) {
				const q = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
				const fres = await fetch(base + '/view?' + q.toString(), { headers: authOnly(config) });
				if (!fres.ok) throw new Error('ComfyUI /view ' + fres.status);
				return { bytes: new Uint8Array(await fres.arrayBuffer()) };
			}
		}
	}

	if (config.kind === 'meshy') {
		const auth = { Authorization: 'Bearer ' + (config.apiKey || ''), 'Content-Type': 'application/json' };
		const mk = async (body) => {
			const r = await fetch(base + '/openapi/v2/text-to-3d', { method: 'POST', headers: auth, body: JSON.stringify(body) });
			if (!r.ok) throw new Error('Meshy create ' + r.status);
			const jj = await r.json();
			return jj.result || jj.id;
		};
		let taskId = await mk({ mode: 'preview', prompt, should_remesh: true });
		let phase = 'preview';
		log('meshy task ' + taskId);
		for (;;) {
			if (Date.now() > deadline) throw new Error('generation timed out');
			await sleep(3000);
			const r = await fetch(base + '/openapi/v2/text-to-3d/' + encodeURIComponent(taskId), { headers: { Authorization: auth.Authorization } });
			if (!r.ok) continue;
			const task = await r.json();
			const st = String(task.status || '').toUpperCase();
			if (st === 'FAILED' || st === 'CANCELED') throw new Error('Meshy ' + st);
			if (st === 'SUCCEEDED') {
				if (phase === 'preview' && config.mode === 'refine') {
					taskId = await mk({ mode: 'refine', preview_task_id: taskId });
					phase = 'refine';
					continue;
				}
				const url = task.model_urls && (task.model_urls.glb || task.model_urls.gltf);
				if (!url) throw new Error('Meshy returned no GLB url');
				const dl = await fetch(url);
				if (!dl.ok) throw new Error('Meshy GLB download ' + dl.status);
				return { bytes: new Uint8Array(await dl.arrayBuffer()) };
			}
		}
	}

	throw new Error('unknown mesh kind "' + config.kind + '"');
}

/** @param {any} config */
function authOnly(config) {
	return config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {};
}
