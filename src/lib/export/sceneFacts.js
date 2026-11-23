// 63-publish (row 13) — THE LIVE HALF of the scene check: read the scene on screen into the
// SceneFacts object sceneChecks.js judges. Lazy (the Publish tab, the export panel and the
// cloudApi `publishCheck` seam import it on demand), so boot pays nothing for it.
//
// Everything here READS: nothing is written, sent or recorded. The bundle size is measured by
// building the same bundle Publish uploads (local drafts lifted out, no thumbnail render), and
// only for the publish target — Export measures its own zip (63-export).
import { get } from 'svelte/store';
import { objectsGroup, globalScene } from '../../stores/sceneStore';
import { flowGraphs } from '../../stores/flowStore';

/** node types that make a scene a GAME for the spawn and touch rules (beside a game shell) */
const GAME_NODE_TYPES = new Set([
	'charcontroller',
	'possessnode',
	'keypress',
	'gamepadbutton',
	'gamepadaxis',
	'ongamestate',
	'setgamestate',
	'camerafollow',
	'moveinput'
]);
/** the keys the stick already stands for (touchActions MOVEMENT_CODES, not exported there) */
const MOVEMENT = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** @param {number} n */
const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

/**
 * @param {{target?: string, bundle?: boolean}} [opts] `bundle` false skips the bundle build
 * @returns {Promise<import('./sceneChecks.js').SceneFacts>}
 */
export async function gatherSceneFacts(opts = {}) {
	const target = opts.target || 'publish';
	const group = /** @type {any} */ (get(objectsGroup));
	const graphs = /** @type {Record<string, any>} */ (get(flowGraphs) || {});
	/** @type {any[]} */
	const nodes = [];
	for (const [gid, g] of Object.entries(graphs)) for (const n of g?.nodes ?? []) nodes.push({ ...n, __graph: gid });

	const [{ resolvePlaySettings }, { gameStateSnapshot }, { dungeonData }] = await Promise.all([
		import('../playSettings'),
		import('../gameState'),
		import('../dungeonPlay')
	]);
	const scene = get(globalScene);
	const play = resolvePlaySettings(scene);
	const isGame = !!gameStateSnapshot() || nodes.some((n) => GAME_NODE_TYPES.has(n.type));

	/** @type {import('./sceneChecks.js').SceneFacts} */
	const facts = {
		isGame,
		spawn: play.spawn ?? null,
		bounds: play.boundsOwner ? null : play.bounds ?? null,
		dungeon: !!dungeonData(scene),
		textures: [],
		assets: [],
		modules: [],
		touch: null,
		scripts: [],
		layers: []
	};

	// objects: texture sizes and layers, one walk
	group?.traverse?.((/** @type {any} */ o) => {
		if (o === group || o.userData?.__localOnly) return;
		const mask = o.layers?.mask ?? 1;
		const eyes = mask & 0b110;
		if (mask & (1 << 30) || (!(mask & 1) && eyes && eyes !== 0b110)) facts.layers?.push({ uuid: o.uuid, name: o.name || o.type, mask });
		if (!o.material) return;
		const mats = Array.isArray(o.material) ? o.material : [o.material];
		mats.forEach((/** @type {any} */ m, /** @type {number} */ slot) => {
			const img = m?.map?.image;
			const w = img?.width ?? img?.naturalWidth ?? 0;
			const h = img?.height ?? img?.naturalHeight ?? 0;
			if (w && h) facts.textures?.push({ uuid: o.uuid, name: o.name || o.type, ...(slot ? { slot } : {}), width: w, height: h });
		});
	});

	// referenced files whose bytes are not here (the bundler skips them silently)
	try {
		const { sceneAssets, refreshSceneAssets } = await import('../sceneAssets');
		refreshSceneAssets?.();
		for (const a of /** @type {any[]} */ (get(sceneAssets))) {
			if (!a?.hash) continue;
			facts.assets?.push({ name: String(a.name || a.hash.slice(0, 8)), kind: String(a.kind || a.group || 'file'), hash: a.hash, missing: !a.itemId, ...(a.uuid ? { uuid: a.uuid } : {}), ...(a.nodeId ? { nodeId: a.nodeId } : {}) });
		}
	} catch {
		/* no asset view: the rule has nothing to say */
	}

	// modules a visitor cannot get: installed here (zip / URL), not in the gallery
	try {
		const [{ moduleRequirements }, { userModules }, gallery, sdk] = await Promise.all([
			import('../moduleRequirements'),
			import('../userModules'),
			import('../moduleGallery'),
			import('../moduleSDK')
		]);
		if (get(gallery.galleryState) === 'idle') await gallery.loadModuleGallery().catch(() => {});
		const galleryOk = get(gallery.galleryState) === 'ready';
		const galleryIds = new Set(/** @type {any[]} */ (get(gallery.galleryModules)).map((m) => m?.id));
		const mine = /** @type {any[]} */ (get(userModules));
		for (const m of moduleRequirements()) {
			const rec = mine.find((r) => r?.id === m.id);
			const loaded = /** @type {any[]} */ (sdk.loadedModules ?? []).find((x) => x?.id === m.id);
			facts.modules?.push({ id: m.id, name: rec?.name || loaded?.name || m.id, user: !!rec, inGallery: galleryOk ? galleryIds.has(m.id) : null });
		}
	} catch {
		/* the module view could not be read: no rows rather than wrong ones */
	}

	// phone controls: every key a Key Press node listens for that no on-screen button presses
	if (isGame) {
		try {
			const { touchSpec } = await import('../touchSpec');
			const spec = /** @type {any} */ (get(touchSpec));
			const covered = new Set((spec?.actions ?? []).flatMap((/** @type {any} */ a) => a.keys ?? []));
			/** @type {string[]} */
			const uncovered = [];
			const { keyLabel } = await import('../touchActions');
			for (const n of nodes) {
				if (n.type === 'keypress') {
					const code = String(n.data?.code || '');
					if (code && !MOVEMENT.has(code) && !covered.has(code) && !uncovered.includes(keyLabel(code))) uncovered.push(keyLabel(code));
				} else if ((n.type === 'gamepadbutton' || n.type === 'gamepadaxis') && !uncovered.includes('a gamepad input')) uncovered.push('a gamepad input');
			}
			facts.touch = { uncovered };
		} catch {
			facts.touch = null;
		}
	}

	for (const n of nodes) if (n.type === 'script') facts.scripts?.push({ id: n.id, code: String(n.data?.code ?? ''), graph: n.__graph });

	if (target === 'publish' && opts.bundle !== false) {
		try {
			Object.assign(facts, await measureBundle(facts));
		} catch {
			facts.bundleBytes = null;
		}
	}
	return facts;
}

/**
 * The publish bundle's size and its biggest parts — the same build `buildSceneBundle` uploads.
 * @param {import('./sceneChecks.js').SceneFacts} facts
 */
async function measureBundle(facts) {
	const { buildSessionPayload, exportSessionZip } = await import('../sessions');
	const { withoutLocalObjects } = await import('../objectPermissions');
	const { currentLevel } = await import('../levels');
	const { result: payload } = withoutLocalObjects(() => buildSessionPayload(String(/** @type {any} */ (get(currentLevel))?.name || 'Untitled'), { thumbnail: false }));
	const zip = await exportSessionZip(payload, { assets: true, flow: true, packs: false, chats: 'published' });
	/** @type {{label: string, bytes: number, where?: string}[]} */
	const parts = [];
	const { itemByHash } = await import('../explorer');
	for (const a of facts.assets ?? []) {
		const item = /** @type {any} */ (itemByHash(a.hash));
		if (item?.size) parts.push({ label: `${a.name} (${kb(item.size)})`, bytes: item.size, ...(a.uuid ? { where: a.uuid } : {}) });
	}
	for (const t of facts.textures ?? []) {
		const bytes = Math.round(t.width * t.height * 0.5); // an encoded image is ~4 bits a pixel; an estimate for ranking
		parts.push({ label: `${t.name} texture ${t.width} x ${t.height} (about ${kb(bytes)})`, bytes, where: t.uuid });
	}
	parts.sort((a, b) => b.bytes - a.bytes);
	return { bundleBytes: zip.length ?? zip.byteLength ?? 0, biggest: parts.slice(0, 5) };
}
