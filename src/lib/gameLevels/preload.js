// 93 LP1 / LP2 — PRELOAD A LEVEL'S SCENE while the player is near its portal: the scene file (pulled from a
// peer when this machine lacks it), its parse, and its pack files (the CDN models it places) into the HTTP
// cache. A scene that finished preloading is READY: its hop shows no loading screen (a fade covers it).
// Every byte counted here feeds the loading screen's real progress when the hop starts before the preload
// finished (loading.js reads `preloadProgress`).

/** scene name -> {state, bytes, total} @type {Map<string, {state: 'loading' | 'ready' | 'failed', bytes: number, total: number}>} */
const scenes = new Map();
/** at most this many pack files are warmed per scene (a huge scene still gets its first pieces fast) */
const MAX_PACK_FILES = 60;

/** is a scene's preload finished? @param {string} name */
export function sceneReady(name) {
	return scenes.get(String(name))?.state === 'ready';
}

/** {bytes, total} preloaded for a scene so far (total 0 = not known yet) @param {string} name */
export function preloadProgress(name) {
	const s = scenes.get(String(name));
	return s ? { bytes: s.bytes, total: s.total, state: s.state } : null;
}

/** every pack file a session payload's objects name (plain ObjectLoader JSON, walked without parsing) @param {any} payload */
export function packPathsOf(payload) {
	/** @type {Set<string>} */
	const out = new Set();
	/** @param {any} node */
	const walk = (node) => {
		if (!node || typeof node !== 'object') return;
		const ud = node.userData;
		if (ud?.packRef?.path && typeof ud.packRef.path === 'string') out.add(ud.packRef.path);
		if (ud?.animRef?.path && typeof ud.animRef.path === 'string') out.add(ud.animRef.path);
		for (const c of node.children ?? []) walk(c);
		if (node.object) walk(node.object);
	};
	for (const element of payload?.objects ?? []) walk(element);
	return [...out];
}


/**
 * Start (or join) the preload of a project scene. Resolves when it is ready (or failed: never throws).
 * @param {string} name @returns {Promise<boolean>}
 */
export async function preloadScene(name) {
	const key = String(name ?? '').trim();
	if (!key) return false;
	const known = scenes.get(key);
	if (known && known.state !== 'failed') return known.state === 'ready';
	const entry = { state: /** @type {'loading' | 'ready' | 'failed'} */ ('loading'), bytes: 0, total: 0 };
	scenes.set(key, entry);
	try {
		const { latestSceneHash } = await import('../projectManifest');
		const hash = latestSceneHash(key);
		if (!hash) throw new Error('no such scene');
		const levels = await import('../levels.js');
		const item = await levels.resolveLevelItem(hash);
		const { itemBlob } = await import('../explorer');
		const blob = await itemBlob(item.id);
		if (!blob) throw new Error('no bytes');
		entry.bytes += blob.size;
		entry.total += blob.size;
		const { readSessionZip } = await import('../sessions');
		const payload = await readSessionZip(await blob.arrayBuffer());
		// the paths come from the scene file: the pack references' own address rule decides
		const { packAddress } = await import('../packRefs');
		const paths = packPathsOf(payload).slice(0, MAX_PACK_FILES);
		await Promise.all(
			paths.map(async (p) => {
				try {
					const url = packAddress(p);
					if (url === 'data:,') return;
					const res = await fetch(url, { priority: 'low' });
					const len = Number(res.headers.get('content-length')) || 0;
					entry.total += len;
					const buf = await res.arrayBuffer();
					entry.bytes += buf.byteLength;
					if (!len) entry.total += buf.byteLength;
				} catch {
					/* a missing piece loads (or fails) on its own during the hop */
				}
			})
		);
		entry.state = 'ready';
		return true;
	} catch {
		entry.state = 'failed';
		return false;
	}
}

/** a scene was just loaded: it is ready for the next trip (a second trip skips the screen) @param {string} name */
export function noteSceneLoaded(name) {
	const key = String(name ?? '').trim();
	if (!key) return;
	const s = scenes.get(key);
	scenes.set(key, { state: 'ready', bytes: s?.bytes ?? 0, total: s?.total ?? 0 });
}

/** tests */
export function resetPreloads() {
	scenes.clear();
}
