// Roadmap 66 S4b — the `import_file` agent tool: a file made OUTSIDE the app by a tool on the agent's own
// machine (a Pixling sprite sheet and its spec, an ImageMagick render, a .tpanim clip) lands in the
// session. 56's `import_model` does this for GLB models; this is the same door for everything else the
// app can hold as a file. The rules (type by bytes, caps, metadata strip, roles) are importFileCore.js.
//
// WHERE IT LANDS
//   · the EXPLORER, in `folder` (default "Generated"), SHARED — so every peer files it in the same
//     folder and the bytes ride assetShare (the 56 Keep-in-Explorer path)
//   · with a `spec`, the generator's input is stored BESIDE the sheet as `<stem>.<generator>.json`
//     (`knight.png` + `knight.pixling.json`, roadmap 66 F2), so a later browser path — or the next agent
//     — regenerates or varies it from the exact input
//   · an image is also PLACED (unless `place: false`): a card mesh (a plane with the image as its map,
//     `nearest` filtering for pixel art, optional one-frame window of a sheet, optional camera facing —
//     imageCards.js) through the ordinary replicated object path, so it syncs, saves and undoes like
//     any object; its files then also ride the scene's .tpscene (Scene ▸ generated)
//
// ONE UNDO STEP for the whole import (the agent's exec batch, or our own when called alone): the card's
// `create` entry plus a `libraryfile` entry whose undo moves the files THIS import created to the
// Deleted bin (shared, so peers bin them too) and whose redo restores them. A file that was already in
// the library (same bytes) is left alone by the undo.
//
// The A8 action log picks the call up through executeAiTool's observer like any tool, so it is one
// line with per-line Undo in the AI assistant window.

import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../../stores/sceneStore.js';
import { peers, userdata } from '../../stores/appStore.js';
import { rolesInfo } from '$lib/cloudHooks';
import { beginHistoryBatch, endHistoryBatch, historyBatchOpen, recordEntry, recordObjectPresence, registerHistoryKind } from '$lib/history';
import { APP_VERSION } from '$lib/version.js';
import { toBase64 } from '../chat/attachCore.js';
import {
	sniffFile,
	sizeRefusal,
	cleanBytes,
	imageSize,
	fileName,
	stemOf,
	generatorTag,
	specBytes,
	folderPath,
	frameWindow,
	cardSize,
	filterFor,
	facingOf,
	importRefusal,
	addChunk,
	CARD_TEXTURE_MAX,
	CARD_TEXTURE_BYTES,
	MAX_FILE_BYTES
} from './importFileCore.js';

/** unfinished chunked uploads, by id (addChunk owns the rules) @type {Map<string, any>} */
const uploads = new Map();

/** base64 (with or without a data: prefix) → bytes @param {string} s */
function decodeBase64(s) {
	const b64 = s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : s;
	const bin = atob(b64.replace(/\s+/g, ''));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** @param {unknown} v @param {number} n */
function nums(v, n) {
	return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? /** @type {number[]} */ (v) : null;
}

/** who is importing: this page's peer, as the roster names it */
function importer() {
	/** @type {any} */
	const p = get(peers);
	const id = p?.peer?.id ?? '';
	const row = (/** @type {any[]} */ (get(userdata)) ?? []).find((u) => Array.isArray(u) && u[0] === id);
	return { peerId: id, name: row?.[1] ? String(row[1]) : '' };
}

/** @param {Uint8Array} b */
const bufferOf = (b) => /** @type {ArrayBuffer} */ (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** the folder path → a folder id, creating what is missing (root level first) @param {string[]} path */
async function ensureFolder(path) {
	const explorer = await import('$lib/explorer');
	await explorer.loadExplorer();
	/** @type {string | null} */
	let parent = null;
	/** @type {string[]} */
	const made = [];
	for (const name of path) {
		const found = get(explorer.explorerFolders).find((f) => f.name === name && (f.parentId ?? null) === parent);
		/** @type {any} */
		const folder = found ?? explorer.createFolder(name, parent);
		if (!folder) return { id: parent, made };
		if (!found) made.push(folder.id);
		parent = folder.id;
	}
	return { id: parent, made };
}

/**
 * One file into the library: `{item, created}` — `created` is false when these exact bytes were
 * already there (the Explorer dedupes by hash), which is what the undo must leave alone.
 * @param {Uint8Array} bytes @param {string} name @param {string | null} folderId @param {{kind?: string}} [opts]
 */
async function addFile(bytes, name, folderId, opts = {}) {
	const explorer = await import('$lib/explorer');
	const hash = await explorer.hashBytes(bufferOf(bytes));
	const had = explorer.itemByHash(hash);
	const item = had ?? (await explorer.addItemFromBytes(bufferOf(bytes), name, folderId, opts.kind ? { kind: opts.kind } : {}));
	return { item, created: !had };
}

/** share the folder chain + the items (peers file them the same way; the bytes ride assetShare) @param {string | null} folderId @param {any[]} items */
async function shareAll(folderId, items) {
	try {
		const lib = await import('$lib/sharedLibrary');
		if (folderId) lib.shareFolder?.(folderId);
		for (const it of items) lib.shareItem?.(it.id);
		// the row BEFORE the bytes (the conn is ordered): shareItem's publish is debounced, and bytes
		// that land with no row become a stray local copy at a peer's library root (assetShare.landBytes)
		lib.publishMine?.(true);
		const assets = await import('$lib/assetShare');
		for (const it of items) void assets.sendAsset(it.hash);
	} catch {
		/* sharing is best-effort: the card names the hashes, so a peer can still pull them */
	}
}

// the undo half of "the files this import created": bin them / bring them back, both shared
registerHistoryKind('libraryfile', (/** @type {any} */ entry, /** @type {any} */ state) => {
	const present = state === entry.after;
	void (async () => {
		const explorer = await import('$lib/explorer');
		const lib = await import('$lib/sharedLibrary');
		if (present) {
			for (const hash of entry.hashes) lib.restoreDeletedItem?.(hash);
		} else {
			const ids = get(explorer.explorerItems)
				.filter((i) => entry.hashes.includes(i.hash))
				.map((i) => i.id);
			if (ids.length) lib.deleteItemsToBin?.(ids);
		}
	})().catch(() => {});
	return true;
});

/**
 * The card's texture as a data URL: the cleaned bytes as they are when small enough, else a downscale
 * (smoothing off for nearest, so pixel art stays square pixels).
 * @param {Uint8Array} bytes @param {string} mime @param {{w: number, h: number}} size @param {string} filter
 */
async function cardTexture(bytes, mime, size, filter) {
	const long = Math.max(size.w, size.h);
	const asIs = 'data:' + mime + ';base64,' + toBase64(bytes);
	if (long <= CARD_TEXTURE_MAX && asIs.length <= CARD_TEXTURE_BYTES) return { url: asIs, scaled: false };
	const bitmap = await createImageBitmap(new Blob([bufferOf(bytes)], { type: mime }));
	let scale = Math.min(1, CARD_TEXTURE_MAX / long);
	for (let round = 0; round < 4; round++) {
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(size.w * scale));
		canvas.height = Math.max(1, Math.round(size.h * scale));
		const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
		ctx.imageSmoothingEnabled = filter !== 'nearest';
		ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const url = filter === 'nearest' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/webp', 0.85);
		if (url.length <= CARD_TEXTURE_BYTES) return { url, scaled: true };
		scale *= 0.7;
	}
	return null;
}

/**
 * Build + add the card mesh through the replicated object path. Returns the mesh.
 * @param {any} o
 */
async function placeCard(o) {
	const THREE = await import('three');
	const texture = await new THREE.TextureLoader().loadAsync(o.url);
	texture.colorSpace = THREE.SRGBColorSpace;
	if (o.filter === 'nearest') {
		texture.magFilter = THREE.NearestFilter;
		texture.minFilter = THREE.NearestFilter;
		texture.generateMipmaps = false;
	}
	if (o.window) {
		texture.repeat.set(o.window.repeat[0], o.window.repeat[1]);
		texture.offset.set(o.window.offset[0], o.window.offset[1]);
	}
	const crisp = o.filter === 'nearest';
	const common = { map: texture, side: THREE.DoubleSide, transparent: !crisp, alphaTest: crisp ? 0.5 : 0.01 };
	const material = o.lit ? new THREE.MeshStandardMaterial({ ...common, roughness: 1, metalness: 0 }) : new THREE.MeshBasicMaterial(common);
	material.userData.mapDataUrl = o.url;
	material.userData.mapSource = o.card.hash; // 40-image: the Explorer file this texture is
	const mesh = new THREE.Mesh(new THREE.PlaneGeometry(o.size.width, o.size.height), material);
	mesh.name = o.name;
	const [px, py, pz] = /** @type {number[]} */ (o.position);
	mesh.position.set(px, py, pz);
	const [rx, ry, rz] = /** @type {number[]} */ (o.rotation).map((d) => (d * Math.PI) / 180);
	mesh.quaternion.setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
	mesh.userData.imageCard = o.card;
	mesh.userData.provenance = o.provenance;
	const group = get(objectsGroup);
	if (!group) throw new Error('the scene is not ready');
	group.add(mesh);
	recordObjectPresence('create', mesh);
	/** @type {any} */
	const link = get(peers);
	link?.send?.({ type: 'object', element: mesh.toJSON() });
	pokeScene();
	const cards = await import('./imageCards.js');
	await cards.startImageCards();
	cards.refreshImageCards();
	return mesh;
}

/**
 * The tool. Never throws: `{file, spec?, uuid?, …, note}`, `{received, of}` for a chunk that is not the
 * last, or `{error}`.
 * @param {any} args `{data?, chunk?, name?, folder?, spec?, generator?, place?, position?, rotation?, height?, width?,
 *   frame?, filter?, facing?, lit?, source?, licence?, prompt?}`
 */
export async function importFileTool(args = {}) {
	const refusal = importRefusal(/** @type {any} */ (get(rolesInfo))?.myRole);
	if (refusal) return { error: refusal, refused: true, role: 'viewer' };

	let data = typeof args.data === 'string' ? args.data : '';
	if (args.chunk) {
		const got = addChunk(uploads, args.chunk, data, Date.now());
		if ('error' in got) return { error: got.error };
		if (!got.done) return { received: got.received, of: got.total, partial: true, note: 'chunk kept; send the rest with the same chunk.id' };
		data = got.data;
	}
	if (!data) return { error: 'pass the file as `data` (base64), in `chunk`s, or (through the bridge) a local `path`' };
	if (data.length > ((MAX_FILE_BYTES + 3) / 3) * 4 + 128) return { error: 'the file is over the largest import_file takes (' + MAX_FILE_BYTES / 1048576 + ' MB)' };
	/** @type {Uint8Array} */
	let raw;
	try {
		raw = decodeBase64(data);
	} catch {
		return { error: 'data is not valid base64' };
	}
	const type = sniffFile(raw);
	if ('error' in type) return { error: type.error };
	const tooBig = sizeRefusal(type, raw.length);
	if (tooBig) return { error: tooBig };
	const spec = specBytes(args.spec);
	if (spec && !spec.ok) return { error: spec.error };

	const { bytes, stripped } = cleanBytes(raw, type);
	const isImage = type.kind === 'png' || type.kind === 'webp';
	const size = isImage ? imageSize(bytes) : null;
	if (isImage && !size) return { error: 'the image header does not say its size — re-save it as a plain PNG' };
	const filter = filterFor(args.filter, { hasSpec: !!spec, size });
	const crop = isImage && args.frame != null ? frameWindow(args.frame, /** @type {any} */ (size)) : null;
	if (crop && 'error' in crop) return { error: crop.error };
	const place = isImage && args.place !== false;
	const position = nums(args.position, 3);
	const rotation = nums(args.rotation, 3) ?? [0, 0, 0];

	const name = fileName(args.name, type.ext);
	const who = importer();
	const provenance = {
		tool: 'import_file',
		model: String(args.model ?? (who.name || 'agent')).slice(0, 120),
		version: String(APP_VERSION),
		licence: String(args.licence ?? '').slice(0, 120),
		...(args.prompt ? { prompt: String(args.prompt).slice(0, 500) } : {}),
		date: new Date().toISOString(),
		source: String(args.source ?? '').slice(0, 300) || (spec ? generatorTag(args.generator) : 'agent file'),
		by: who
	};

	/** @type {string[]} */
	const warnings = [];
	const ownBatch = !historyBatchOpen();
	if (ownBatch) beginHistoryBatch();
	try {
		const folder = await ensureFolder(folderPath(args.folder));
		const main = await addFile(bytes, name, folder.id, type.kind === 'tpanim' ? { kind: 'anim' } : {});
		if (!main.item) throw new Error('the Explorer refused the file');
		const files = [main];
		/** @type {any} */
		let specFile = null;
		if (spec) {
			specFile = await addFile(spec.bytes, stemOf(main.item.name) + '.' + generatorTag(args.generator) + '.json', folder.id);
			if (specFile.item) files.push(specFile);
		}
		await shareAll(folder.id, files.map((f) => f.item));
		const createdHashes = files.filter((f) => f.created).map((f) => f.item.hash);
		if (createdHashes.length) recordEntry({ kind: 'libraryfile', hashes: createdHashes, before: { present: false }, after: { present: true } });

		/** @type {any} */
		let mesh = null;
		if (place && size) {
			const px = crop ? { w: crop.w, h: crop.h } : size;
			const dims = cardSize(px, args);
			const tex = await cardTexture(bytes, type.mime, size, filter);
			if (!tex) warnings.push('the image is too large to place as a card even downscaled; it is in the Explorer only');
			else {
				if (tex.scaled) warnings.push('the card shows a downscaled copy (the Explorer file is full size)');
				const card = {
					hash: main.item.hash,
					name: main.item.name,
					...(specFile?.item ? { specHash: specFile.item.hash, specName: specFile.item.name, generator: generatorTag(args.generator) } : {}),
					filter,
					...(facingOf(args.facing) ? { facing: facingOf(args.facing) } : {}),
					...(crop ? { frame: { w: crop.w, h: crop.h, col: Number(args.frame.col ?? 0), row: Number(args.frame.row ?? 0) } } : {}),
					px: size
				};
				mesh = await placeCard({
					url: tex.url,
					filter,
					window: crop,
					lit: args.lit === true,
					size: dims,
					name: stemOf(main.item.name),
					position: position ?? [0, dims.height / 2, 0],
					rotation,
					card,
					provenance
				});
			}
		}
		if (ownBatch) endHistoryBatch('Import ' + main.item.name);
		const folderName = folderPath(args.folder).join('/');
		return {
			file: { name: main.item.name, hash: main.item.hash, kind: type.kind, bytes: bytes.length, folder: folderName, ...(main.created ? {} : { existed: true }) },
			...(stripped.length ? { stripped } : {}),
			...(specFile?.item ? { spec: { name: specFile.item.name, hash: specFile.item.hash } } : {}),
			...(size ? { pixels: size } : {}),
			...(mesh ? { uuid: mesh.uuid, name: mesh.name, filter, size: { width: +cardSizeRound(mesh, 'width'), height: +cardSizeRound(mesh, 'height') } } : {}),
			provenance,
			...(warnings.length ? { warnings } : {}),
			note:
				'In the Explorer ▸ ' +
				folderName +
				(specFile?.item ? ' with its spec beside it' : '') +
				', shared with every peer' +
				(mesh ? '; placed as a card (update_objects moves it, frame / facing are import options)' : '') +
				'. One undo step.'
		};
	} catch (e) {
		if (ownBatch) endHistoryBatch('Import ' + name);
		return { error: 'the import failed: ' + String(/** @type {any} */ (e)?.message ?? e) };
	}
}

/** @param {any} mesh @param {'width' | 'height'} key */
function cardSizeRound(mesh, key) {
	return Number(mesh.geometry?.parameters?.[key] ?? 0).toFixed(3);
}

/** the OpenAI-format schema (agents only: tpAgent offers it; a small local model is not handed base64) */
export const IMPORT_FILE_TOOL = {
	type: 'function',
	function: {
		name: 'import_file',
		description:
			'Bring a file made on your machine into the session: PNG / WebP images (≤ 16 MB, metadata stripped), JSON (≤ 2 MB) or a .tpanim clip. The type is read from the bytes. ' +
			'It lands in the Explorer (folder "Generated" unless `folder`), shared with every peer. Pass the generator\'s input as `spec` and it is saved beside the file as <name>.<generator>.json ' +
			'(e.g. knight.png + knight.pixling.json) so it can be regenerated. An image is also placed in the scene as a card (a plane; `place: false` to skip): `filter: "nearest"` keeps pixel art crisp ' +
			'(default when a spec is given), `frame: {w, h, col, row}` shows one frame of a sprite sheet, `facing: "camera-y"` turns it to face each viewer. One undo step; editors and admins only. ' +
			'Large files: send base64 parts with `chunk: {id, index, total}` (the bridge does this for you with `path`).',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'a local file on the agent\'s machine (the bridge reads it)' },
				data: { type: 'string', description: 'the file as base64 (or this chunk\'s part of it)' },
				chunk: {
					type: 'object',
					description: 'a chunked upload: every part has the same id; the import runs when the last part arrives',
					properties: { id: { type: 'string' }, index: { type: 'number' }, total: { type: 'number' } }
				},
				name: { type: 'string', description: 'the file name in the Explorer (its extension comes from the bytes)' },
				folder: { type: 'string', description: 'Explorer folder, "A/B" for nested (default "Generated")' },
				spec: { description: 'the generator input (JSON object or string), saved beside the file' },
				spec_path: { type: 'string', description: 'the spec as a local .json file (the bridge reads it)' },
				generator: { type: 'string', description: 'names the spec file, default "pixling"' },
				place: { type: 'boolean', description: 'images: place a card in the scene (default true)' },
				position: { type: 'array', items: { type: 'number' }, description: '[x,y,z] metres (default: standing on the ground at the origin)' },
				rotation: { type: 'array', items: { type: 'number' }, description: '[x,y,z] degrees' },
				height: { type: 'number', description: 'card height in metres (default 1; width follows the aspect)' },
				width: { type: 'number', description: 'card width in metres (instead of height)' },
				frame: {
					type: 'object',
					description: 'show one frame of a sheet: w/h in pixels, col/row from 0 (row 0 = top)',
					properties: { w: { type: 'number' }, h: { type: 'number' }, col: { type: 'number' }, row: { type: 'number' } }
				},
				filter: { type: 'string', enum: ['auto', 'nearest', 'linear'], description: 'texture filtering (auto = nearest for pixel art)' },
				facing: { type: 'string', enum: ['none', 'camera', 'camera-y'], description: 'billboard: face each viewer (camera-y = turn about Y only)' },
				lit: { type: 'boolean', description: 'shade the card with the scene lights (default unlit, like a sprite)' },
				source: { type: 'string', description: 'where it came from, e.g. "pixling 0.3.1 build specs/knight.json"' },
				licence: { type: 'string', description: 'its licence, e.g. CC0, "own work"' },
				prompt: { type: 'string', description: 'the request it was made for' }
			}
		}
	}
};
