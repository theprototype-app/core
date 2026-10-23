// 59 T4 — Test for a mesh-generation provider (Settings ▸ Tools & connections). Mesh providers had
// no Test at all: the first sign of a wrong URL or key was a failed generation. Both probes are
// READ-ONLY and cost nothing — ComfyUI answers `GET /system_stats`; Meshy lists our own tasks
// (`GET /openapi/v2/text-to-3d?page_size=1`, no generation, no credits). A ComfyUI workflow is
// checked locally (valid JSON with a {{PROMPT}} slot) because a server can be up while the
// workflow it was given cannot run.

/** @param {any} config a MeshProviderConfig @param {AbortSignal} [signal] @returns {Promise<{ok: boolean, detail: string}>} */
export async function testMeshProvider(config, signal) {
	const base = String(config?.baseUrl ?? '').replace(/\/+$/, '');
	if (!base) return { ok: false, detail: 'No URL set' };
	/** @type {Record<string, string>} */
	const headers = config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {};
	if (config.kind === 'meshy' && !config.apiKey)
		return { ok: false, detail: 'Meshy needs an API key' };
	const url =
		config.kind === 'meshy' ? base + '/openapi/v2/text-to-3d?page_size=1' : base + '/system_stats';
	/** @type {Response} */
	let res;
	try {
		res = await fetch(url, { headers, signal });
	} catch {
		return {
			ok: false,
			detail:
				config.kind === 'comfyui'
					? 'Could not reach ComfyUI — is it running, and started with --enable-cors-header?'
					: 'Could not reach ' + base
		};
	}
	if (res.status === 401 || res.status === 403)
		return { ok: false, detail: 'The server refused the key (HTTP ' + res.status + ')' };
	if (!res.ok) return { ok: false, detail: 'HTTP ' + res.status + ' from ' + base };
	if (config.kind === 'comfyui') {
		const wf = String(config.workflowJson ?? '').trim();
		if (!wf) return { ok: false, detail: 'ComfyUI answers, but no workflow is set' };
		try {
			JSON.parse(wf);
		} catch {
			return { ok: false, detail: 'ComfyUI answers, but the workflow is not valid JSON' };
		}
		if (!wf.includes('{{PROMPT}}'))
			return { ok: false, detail: 'ComfyUI answers, but the workflow has no {{PROMPT}} slot' };
		return { ok: true, detail: 'Connected — ComfyUI answers and the workflow is ready' };
	}
	return { ok: true, detail: 'Connected — the key works' };
}
