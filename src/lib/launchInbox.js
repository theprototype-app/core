// launchInbox.js — 60 Q4: files that arrive FROM THE OS rather than through a picker.
//
// Two doors, one router:
//   · "Share → theprototype" (Android share sheet, desktop Chrome share) — the manifest's
//     `share_target` POSTs the files to /share-target, which only the service worker can
//     receive on a static site (static/sw.js): it parks them in the `tp-share-inbox` cache
//     and redirects to /?shared=<n>. `readShareInbox` collects them ONCE and deletes the
//     cache. Chromium ignores `launch_handler` for share launches, so this is always a
//     fresh navigation and the worker always sees the POST.
//   · Double-click a .tpscene / .glb / .gltf on the desktop (installed PWA, `file_handlers`)
//     — the files arrive on `window.launchQueue`. `launch_handler: focus-existing` sends a
//     second double-click to the window already open, whose consumer runs again.
//
// What each file does (`classifyLaunchFiles`, PURE): a .tpscene OPENS (the Sidebar Load
// path — the scene replaces the world, unsaved, proposed to peers when connected; one at a
// time), models are IMPORTED into the current scene (the import dialog's path, so an .obj's
// .mtl and textures ride along), and an image on its own goes into the Explorer LIBRARY with
// a "Show in Library" action — a picture has no single right place in a 3D scene, and the
// library is where every texture/HUD/shader picker already reads from. The same toast offers
// "Use as reference" (60 Q5): the image also becomes a reference underlay on the ground, the
// choice a viewport drop of an image offers.
//
// Nothing runs until the boot is ready to take it: the scene group exists AND the
// restore-session question is answered (`restoreSettled`), because a model imported into
// the empty boot scene is wiped by a Restore pressed a second later, and a scene opened over
// the prompt overwrites the very autosave it offers.
import { objectsGroup } from '../stores/sceneStore';
import { explorerClose, showInfoToast, showToast } from '../stores/appStore';

// kept in step with static/sw.js
export const SHARE_INBOX = 'tp-share-inbox';
export const SHARE_PARAM = 'shared';

const SCENE_EXT = /\.tpscene$/i;
const MODEL_EXT = /\.(glb|gltf|obj|stl|fbx)$/i;
const COMPANION_EXT = /\.(mtl|png|jpe?g|webp|bmp|gif)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|heic|heif|avif)$/i;

/**
 * Sort a launch's files into what each will do. PURE. Images travel as a model's
 * companions when a model came with them (an .obj and its textures), otherwise each one
 * is a library image.
 * @template {{name: string, type?: string}} F
 * @param {F[]} files
 * @returns {{scenes: F[], models: F[], companions: F[], images: F[], skipped: F[]}}
 */
export function classifyLaunchFiles(files) {
	/** @type {{scenes: F[], models: F[], companions: F[], images: F[], skipped: F[]}} */
	const out = { scenes: [], models: [], companions: [], images: [], skipped: [] };
	const list = [...(files ?? [])].filter(Boolean);
	const hasModel = list.some((f) => MODEL_EXT.test(f.name ?? ''));
	for (const f of list) {
		const name = f.name ?? '';
		if (SCENE_EXT.test(name)) out.scenes.push(f);
		else if (MODEL_EXT.test(name)) out.models.push(f);
		else if (hasModel && COMPANION_EXT.test(name)) out.companions.push(f);
		else if (IMAGE_EXT.test(name) || String(f.type ?? '').startsWith('image/')) out.images.push(f);
		else out.skipped.push(f);
	}
	return out;
}

/** the boot is ready for a launch: the scene exists and the restore question is answered */
async function bootReady() {
	await new Promise((resolve) => {
		const off = objectsGroup.subscribe((group) => {
			if (!group) return;
			queueMicrotask(() => off());
			resolve(undefined);
		});
	});
	const { restoreSettled } = await import('./autosave');
	await restoreSettled();
}

/**
 * Route a launch's files. Serialised, so two launches in quick succession (two
 * double-clicks) land in order instead of interleaving their imports.
 * @param {File[]} files @param {'share' | 'open'} source
 * @returns {Promise<{scene: string | null, models: number, images: number, skipped: string[]}>}
 */
export function receiveLaunchFiles(files, source) {
	const run = queue.then(() =>
		route(files, source).catch((e) => {
			lastLaunch.value = { source, error: String(e?.message ?? e) };
			showToast(`Could not open ${files.map((f) => f.name).join(', ')}: ${lastLaunch.value.error}`);
			throw e;
		})
	);
	queue = run.catch(() => {});
	return run;
}
/** @type {Promise<any>} */
let queue = Promise.resolve();

/** 60 Q5: shared images as reference underlays on the ground, then the window that edits them
 * @param {File[]} files */
async function useAsReference(files) {
	const [{ addUnderlay, underlayWindowOpen }, { underlayPoseFromView }] = await Promise.all([
		import('./underlays'),
		import('./underlayPose')
	]);
	for (const file of files) {
		const pose = underlayPoseFromView('ground');
		if (!pose) {
			lastLaunch.reference = 'no view';
			showToast('Open the scene view first, then use the picture as a reference');
			return;
		}
		lastLaunch.reference = (await addUnderlay(file, pose)) ? 'added' : 'failed';
	}
	underlayWindowOpen.set(true);
}

/** @param {File[]} files @param {'share' | 'open'} source */
async function route(files, source) {
	const result = {
		scene: /** @type {string | null} */ (null),
		models: 0,
		images: 0,
		skipped: /** @type {string[]} */ ([])
	};
	const c = classifyLaunchFiles(files);
	result.skipped = c.skipped.map((f) => f.name);
	if (!c.scenes.length && !c.models.length && !c.images.length) {
		if (files.length)
			showToast(
				'Cannot open ' +
					result.skipped.join(', ') +
					' — theprototype takes .tpscene, .glb, .gltf and images'
			);
		lastLaunch.value = { source, ...result };
		return result;
	}
	lastLaunch.stage = 'boot';
	await bootReady();
	lastLaunch.stage = 'route';
	// fileHandler is a heavy import; a lone image never needs it
	const fh = c.scenes.length || c.models.length ? await import('./fileHandler.svelte') : null;
	// the scene first: models shared WITH it land in it, not in the world it replaces
	if (c.scenes.length) {
		const scene = c.scenes[0];
		await fh?.load(scene);
		result.scene = scene.name;
		if (c.scenes.length > 1)
			showToast(
				`Opened ${scene.name} — one scene at a time, so the other ${c.scenes.length - 1} stayed closed`
			);
	}
	if (c.models.length) {
		const r = fh?.importModelFiles([...c.models, ...c.companions]);
		result.models = r?.models ?? 0;
	}
	if (c.images.length) {
		lastLaunch.stage = 'images';
		const { importFiles, loadExplorer, revealItem } = await import('./explorer');
		// the library index must be in memory first, or the import's index write would
		// replace the saved library with just this one file
		lastLaunch.stage = 'images:load';
		await loadExplorer();
		lastLaunch.stage = 'images:import';
		const created = await importFiles(c.images, null, { duplicates: 'reuse' });
		lastLaunch.stage = 'images:toast';
		result.images = created.length;
		if (created.length) {
			const first = created[0];
			const label =
				created.length === 1
					? `${first.name} is in your Library`
					: `${created.length} images are in your Library`;
			showInfoToast(
				`launch-images-${Date.now()}`,
				`${label} — drag one onto an object to texture it.`,
				[
					{
						label: 'Show in Library',
						action: () => {
							explorerClose.set(false);
							revealItem(first.id);
						}
					},
					{
						label: 'Use as reference',
						action: () => void useAsReference(c.images)
					}
				]
			);
		}
	}
	if (c.skipped.length)
		showToast('Skipped ' + result.skipped.join(', ') + ' (not a scene, model or image)');
	lastLaunch.value = { source, ...result };
	lastLaunch.stage = 'done';
	return result;
}

/** the last routed launch, and how far the running one got — read by the e2e debug hook */
export const lastLaunch = { value: /** @type {any} */ (null), stage: '', reference: '' };

/**
 * Collect what the service worker parked for a share, ONCE: every file in the inbox, then
 * the cache is deleted and `?shared=` leaves the address bar (a reload must not re-import).
 * @param {{caches?: CacheStorage, location?: Location, history?: History}} [env] injectable for tests
 * @returns {Promise<File[]>}
 */
export async function readShareInbox(env = globalThis) {
	const loc = env.location;
	if (!loc || !new URLSearchParams(loc.search).has(SHARE_PARAM)) return [];
	try {
		const url = new URL(loc.href);
		url.searchParams.delete(SHARE_PARAM);
		env.history?.replaceState(env.history.state, '', url.pathname + url.search + url.hash);
	} catch {
		/* the address bar keeps the param — the inbox is gone either way */
	}
	const store = env.caches;
	if (!store) return [];
	/** @type {File[]} */
	const files = [];
	try {
		const inbox = await store.open(SHARE_INBOX);
		const keys = [...(await inbox.keys())];
		const nth = (/** @type {Request} */ r) => Number(r.url.split('/').pop());
		keys.sort((a, b) => nth(a) - nth(b));
		for (const key of keys) {
			const res = await inbox.match(key);
			if (!res) continue;
			const blob = await res.blob();
			let name = 'shared';
			try {
				name = decodeURIComponent(res.headers.get('X-File-Name') || name);
			} catch {
				/* keep the fallback */
			}
			files.push(
				new File([blob], name, { type: blob.type || res.headers.get('Content-Type') || '' })
			);
		}
	} catch {
		/* an unreadable inbox is an empty one */
	}
	await store.delete(SHARE_INBOX).catch(() => false);
	return files;
}

let started = false;
/** App boot: collect a share, and take file launches for the life of the page. */
export function startLaunchInbox() {
	if (started || typeof window === 'undefined') return;
	started = true;
	void readShareInbox().then((files) => {
		if (files.length) void receiveLaunchFiles(files, 'share');
	});
	/** @type {any} */
	const lq = /** @type {any} */ (window).launchQueue;
	if (lq && typeof lq.setConsumer === 'function') {
		lq.setConsumer(async (/** @type {any} */ params) => {
			const handles = Array.isArray(params?.files) ? params.files : [];
			if (!handles.length) return;
			const files = [];
			for (const h of handles) {
				try {
					if (h && typeof h.getFile === 'function') files.push(await h.getFile());
				} catch {
					/* a handle we may not read is skipped */
				}
			}
			if (files.length) void receiveLaunchFiles(files, 'open');
		});
	}
}
