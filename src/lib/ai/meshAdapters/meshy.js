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
	// Signed CDN url, no auth header. assets.meshy.ai sends NO CORS headers (confirmed
	// against their CDN + docs 2026-07-27), so a direct browser fetch always fails —
	// and even a CAUGHT CORS failure paints a red error in the devtools console. For
	// known no-CORS hosts we therefore go straight through the asset-proxy CHAIN
	// (provider field → dev /proxy → the Cloudflare Worker → the peerjs box; see
	// assetProxyCandidates) and only fall back to a direct attempt if every proxy
	// fails. Unknown hosts still try direct first.
	const candidates = assetProxyCandidates(config);
	const viaProxies = async () => {
		/** @type {any} */
		let lastError = null;
		for (const proxy of candidates) {
			try {
				const res = await fetch(proxy + '?url=' + encodeURIComponent(resultRef.url));
				if (res.ok) return await res.arrayBuffer();
				lastError = new AssetHttpError(res.status, true);
			} catch (err) {
				lastError = err;
			}
		}
		throw lastError ?? new Error('no asset proxy configured');
	};
	let host = '';
	try {
		host = new URL(resultRef.url).hostname;
	} catch {}
	const corsBlocked = NO_CORS_HOSTS.includes(host);

	if (candidates.length && corsBlocked) {
		try {
			return await viaProxies();
		} catch {
			// every proxy down/misconfigured — the direct attempt below is a last
			// resort (it will log a CORS error, but we're on the error path already)
		}
	}
	try {
		const res = await fetch(resultRef.url);
		if (!res.ok) throw new AssetHttpError(res.status, false);
		return await res.arrayBuffer();
	} catch (err) {
		if (err instanceof AssetHttpError) {
			throw new Error('Downloading the Meshy GLB failed (' + err.status + ')');
		}
		// direct fetch died on CORS (TypeError)
		if (!candidates.length) {
			throw new Error(
				"Meshy's CDN blocks browser downloads (no CORS headers). Set an asset proxy on the Meshy provider (Settings → AI → Mesh providers)."
			);
		}
		if (corsBlocked) {
			// the proxy chain already failed above — don't loop back into it
			throw new Error('All asset proxies failed and the CDN blocks direct downloads — is the proxy up?');
		}
		try {
			return await viaProxies();
		} catch (proxyErr) {
			const status = proxyErr instanceof AssetHttpError ? ' (' + proxyErr.status + ')' : '';
			throw new Error('Asset-proxy download failed' + status);
		}
	}
}

/** CDNs that are KNOWN to never send Access-Control-Allow-Origin — skip the doomed
 * direct fetch for these (it would be caught, but each attempt logs a red CORS error
 * in the browser console). */
const NO_CORS_HOSTS = ['assets.meshy.ai'];

/**
 * Ordered asset-proxy candidates, tried until one succeeds (all serve the same
 * `?url=<encoded>` contract). Empty entries drop out (`||`-style — the Settings
 * form saves a blank field as '' and that must fall through):
 *   1. the provider's own assetProxy field
 *   2. dev only: the dev server's same-origin /proxy (vite.config.ts devAssetProxy —
 *      local dev works with NO deployed proxy at all)
 *   3. VITE_ASSET_PROXY (the Cloudflare Worker, proxy.theprototype.app)
 *   4. derived https://<VITE_PEER_HOST>/proxy (the peerjs box) — both the fallback
 *      when the Worker is removed/over-quota AND the default for CI/Pages builds
 *      that bake the peer host but never saw the gitignored-.env proxy var
 * @param {any} config @returns {string[]}
 */
function assetProxyCandidates(config) {
	const env = /** @type {any} */ (import.meta.env);
	const peerHost = String(env.VITE_PEER_HOST || '').trim();
	const raw = [
		String(config.assetProxy || '').trim(),
		env.DEV ? '/proxy' : '',
		String(env.VITE_ASSET_PROXY || '').trim(),
		peerHost ? 'https://' + peerHost + '/proxy' : ''
	];
	return [...new Set(raw.filter(Boolean).map((p) => p.replace(/\/+$/, '')))];
}

/** Distinguishes an HTTP failure from the CORS TypeError inside fetchResult. */
class AssetHttpError extends Error {
	/** @param {number} status @param {boolean} [viaProxy] */
	constructor(status, viaProxy = false) {
		super('asset http ' + status);
		this.status = status;
		this.viaProxy = viaProxy;
	}
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
