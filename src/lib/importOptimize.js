import { writable, get } from 'svelte/store';
import { showToast, showInfoToast, dismissToastById } from '../stores/appStore';
import { objectsGroup } from '../stores/sceneStore';
import {
	addItemFromBytes,
	itemByHash,
	hashBytes,
	patchRecord,
	deleteItem,
	itemBlob
} from './explorer';
import { modelCost } from './importBudget';
import { retainOriginal } from './decimate';
import { generatedGroup } from './lodGroupCore';
import { parseGltfSceneSafe } from './ktx2Twins';
import { optimizeGltf, OptimizeUnsupported } from './gltfOptimize.js';
// 60 Q6: the converted output is kept in the local asset cache, keyed by the source hash + settings
import { readCached, writeCached, cachedEntry } from './assetCache';
import { derivedKey } from './assetCacheCore.js';
import { APP_VERSION } from './version';
import {
	importDecision,
	importOptions,
	shortBytes,
	percentChange
} from './gltfOptimize/presets.js';

// 46 P2 — IMPORT AUTO-OPTIMIZE: what Unity's model + texture importers do, on drop.
//
// THE DECISION (the user's, 2026-10-15): a model over 50k triangles or with a texture over
// 2048 px is optimized as it comes in — its textures resized to the cap and given KTX2/Basis
// twins (ktx2Twins.js: the GPU holds the compressed copy, every serializer the plain one), its
// meshes vertex-cache ordered, and an LOD chain stamped as the object's LOD GROUP
// (`userData.lod`, generated levels — replicated as numbers, built on every peer by the existing
// simplifier worker, so no level bytes travel). LOD0 stays at full detail, the DCC default.
// The ORIGINAL file is always kept in the Library beside the optimized one, and the report toast
// offers "Keep original only".
//
// DEFAULTS live in Settings ▸ Import (LOCAL, this device). A PER-ASSET OVERRIDE lives on the
// original's Library record (`importSettings`, LOCAL like the record): Optimize auto / always /
// never, LOD levels, max texture size, compression — Unity's import inspector. Reimport runs the
// original again under its override and swaps every placed copy.
//
// WHAT IS LEFT ALONE: pack pieces (they carry their own LODs and travel as references), a file
// that already IS an optimized Library item (only its LOD group is stamped again), skinned
// models' LOD chain (a level cannot carry weights), and the texture work on OBJ/STL/FBX — the
// engine is glTF-only, so those get the LOD chain only.

// The settings half (the store, the override, effectiveSettings) is the leaf importSettings.js, so
// Settings ▸ Import and the Explorer panel do not pull this module into the main bundle.
export {
	importSettings,
	setImportSettings,
	resetImportSettings,
	normalizeOverride,
	effectiveSettings,
	setAssetOverride
} from './importSettings.js';
import { effectiveSettings } from './importSettings.js';

/** What a parsed tree weighs, in the two units the thresholds use. @param {any} root */
export function measureImport(root) {
	const cost = modelCost(root);
	let skinned = false;
	root?.traverse?.((/** @type {any} */ o) => {
		if (o.isSkinnedMesh) skinned = true;
	});
	return {
		triangles: cost.triangles,
		maxTextureSide: cost.maxTextureSize,
		textureBytes: cost.textureBytes,
		skinned
	};
}

/** The last import this device optimized (the suite + the docs measurement read it). LOCAL.
 * @type {import('svelte/store').Writable<any>} */
export const lastOptimizedImport = writable(null);

/** @param {any} root */
function disposeTree(root) {
	root?.traverse?.((/** @type {any} */ o) => {
		o.geometry?.dispose?.();
		for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
			for (const key of Object.keys(m)) if (m[key]?.isTexture) m[key].dispose();
			m.dispose?.();
		}
	});
}

/** The words of the report toast. PURE given the summary. @param {string} name @param {any} s */
export function optimizeSummary(name, s) {
	/** @type {string[]} */
	const bits = [];
	if (s.texturesResized)
		bits.push('textures ' + s.textureMaxBefore + ' → ' + s.textureMaxAfter + ' px');
	if (s.ktx2) bits.push('KTX2 compressed');
	if (s.gpuBefore && s.gpuAfter < s.gpuBefore)
		bits.push(
			'texture memory ' +
				shortBytes(s.gpuBefore) +
				' → ' +
				shortBytes(s.gpuAfter) +
				' (' +
				percentChange(s.gpuBefore, s.gpuAfter) +
				')'
		);
	if (s.lod?.length)
		bits.push(
			'LOD chain ' + s.lod.map((/** @type {number} */ r) => Math.round(r * 100) + '%').join(' / ')
		);
	return (
		'Optimized "' +
		name +
		'": ' +
		(bits.join(', ') || 'checked, nothing to change') +
		'. The original is kept in the Library.'
	);
}

/**
 * Optimize a parsed import when the thresholds (or the asset's override) say so. Called by
 * fileHandler.importFile between the parse and the budget gate. Resolves a REPLACEMENT parse
 * (`{root, animated, notes}`) plus the summary for the toast, or null to import as parsed.
 * @param {{root: any, animated: any, notes: string[]}} parsed
 * @param {{file: any, extension: string, label: string, opts?: any}} source
 */
export async function maybeOptimizeImport(parsed, source) {
	const opts = source.opts ?? {};
	if (opts.packRef || opts.lod || opts.noOptimize) return null;
	const bytes =
		typeof source.file?.arrayBuffer === 'function'
			? new Uint8Array(await source.file.arrayBuffer())
			: null;
	if (!bytes) return null;
	const hash = await hashBytes(bytes.buffer);
	/** @type {any} */
	const held = itemByHash(hash);
	// a file that IS an optimized item: its textures are done — only the LOD group again
	const alreadyOptimized = !!held?.optimizedFrom;
	const override = alreadyOptimized
		? /** @type {any} */ (itemByHash(held.optimizedFrom))?.importSettings
		: held?.importSettings;
	const { mode, settings } = effectiveSettings(override);
	if (mode === 'never') return null;
	const root = parsed.animated ? parsed.animated.result?.scene : parsed.root;
	const facts = measureImport(root);
	const decision = importDecision(facts, settings);
	const forced = mode === 'always';
	if (!decision.optimize && !forced) return null;
	const lodRatios =
		!facts.skinned && settings.lodLevels > 0 && (decision.lod || forced) ? settings.lodRatios : [];
	const gltf = source.extension === 'glb' || source.extension === 'gltf';
	// the engine is for TEXTURES (resize + KTX2); a texture-less model only needs its LOD group
	const runEngine =
		gltf &&
		!alreadyOptimized &&
		facts.maxTextureSide > 0 &&
		(decision.textures || settings.compress || forced);
	let next = parsed;
	/** @type {any} */
	let report = null;
	let optimizedBytes = null;
	// 60 Q6: the same file under the same settings converts ONCE per build — the textures'
	// resize + KTX2 encode is the slow part of an import, and its output is a pure function of both
	const engineOptions = importOptions(settings);
	const convertedKey = runEngine
		? derivedKey('texture', hash, { options: engineOptions, v: APP_VERSION })
		: null;
	const converted = convertedKey ? await readCached(convertedKey) : null;
	if (runEngine) {
		const progressId = 'import-optimize-' + hash.slice(0, 12);
		if (!converted)
			showInfoToast(
				progressId,
				'Optimizing "' + source.label + '"… you can keep working while it runs.',
				[],
				undefined,
				true
			);
		try {
			const out = converted
				? {
						bytes: new Uint8Array(converted),
						report: cachedEntry(/** @type {string} */ (convertedKey))?.meta?.report ?? null
					}
				: await optimizeGltf(bytes, engineOptions, {
						onProgress: (p) => {
							if (p.step === 'textures' && p.total)
								showInfoToast(
									progressId,
									'Optimizing "' +
										source.label +
										'": textures ' +
										Math.min(p.total, (p.done ?? 0) + 1) +
										' / ' +
										p.total +
										'…',
									[],
									undefined,
									true
								);
						}
					});
			if (!converted && convertedKey)
				void writeCached(convertedKey, out.bytes.slice().buffer, {
					kind: 'texture',
					type: 'model/gltf-binary',
					meta: { report: out.report }
				});
			report = out.report;
			optimizedBytes = out.bytes;
			const gltfResult = await parseGltfSceneSafe(
				/** @type {ArrayBuffer} */ (
					out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength)
				)
			);
			// 57 M2: a rig without clips rides the bytes path too (fileHandler.hasSkin, inlined: that module imports this one)
			let skinned = false;
			gltfResult.scene?.traverse?.((/** @type {any} */ o) => {
				if (o.isSkinnedMesh) skinned = true;
			});
			const animated =
				gltfResult.animations?.length > 0 || skinned
					? { result: gltfResult, buffer: out.bytes.slice().buffer, kind: 'gltf' }
					: null;
			// 47 C2: a CC0 download's credit rides the root (the GLB's scene extras); the engine's
			// rewrite must not lose it, or the placed copy and the Inspector forget where it came from
			const credit = root?.userData?.source;
			if (credit && gltfResult.scene && !gltfResult.scene.userData?.source)
				gltfResult.scene.userData = { ...(gltfResult.scene.userData ?? {}), source: credit };
			disposeTree(root);
			next = { root: gltfResult.scene, animated, notes: parsed.notes };
		} catch (error) {
			if (error instanceof OptimizeUnsupported) parsed.notes.push(String(error.message));
			else {
				console.error('Import optimize failed:', error);
				parsed.notes.push(
					'Could not optimize "' +
						source.label +
						'" (' +
						String(/** @type {any} */ (error)?.message ?? error) +
						') — it was imported as it is.'
				);
			}
			report = null;
			optimizedBytes = null;
		} finally {
			dismissToastById(progressId);
		}
	}
	if (!optimizedBytes && !lodRatios.length) return null;
	const placed = next.animated ? next.animated.result?.scene : next.root;
	if (lodRatios.length && placed)
		placed.userData = { ...(placed.userData ?? {}), lod: generatedGroup(lodRatios) };
	// THE LIBRARY: the original always, the optimized copy beside it
	const base = String(source.label || 'Model').replace(/\.(glb|gltf|obj|stl|fbx)$/i, '');
	const original =
		held ??
		(await addItemFromBytes(bytes.slice().buffer, base + '.' + source.extension, null, {
			imported: true
		}));
	/** @type {any} */
	let optimizedItem = null;
	if (optimizedBytes) {
		optimizedItem = await addItemFromBytes(
			optimizedBytes.slice().buffer,
			base + ' (optimized).glb',
			original?.folderId ?? null,
			{ imported: true }
		);
		if (optimizedItem && original && optimizedItem.id !== original.id) {
			const summaryForItem = report && {
				bytesBefore: report.bytesBefore,
				bytesAfter: report.bytesAfter,
				gpuBefore: report.gpuBytesBefore,
				gpuAfter: report.gpuBytesAfter,
				trianglesBefore: report.trianglesBefore,
				at: Date.now()
			};
			patchRecord(optimizedItem.id, {
				optimizedFrom: original.hash,
				optimizeReport: summaryForItem,
				// 47 C2: the optimized copy names the same CC0 source as its original (Explorer Properties)
				.../** @type {any} */ ((original).source
					? { source: /** @type {any} */ (original).source }
					: {})
			});
			patchRecord(original.id, { optimizedHash: optimizedItem.hash });
		}
	}
	const textures = report?.textures ?? [];
	const summary = {
		source: original?.hash ?? hash,
		item: optimizedItem?.hash ?? null,
		lod: lodRatios,
		triangles: facts.triangles,
		texturesResized: textures.some((/** @type {any} */ t) => t.after.width !== t.width),
		textureMaxBefore: textures.reduce(
			(/** @type {number} */ m, /** @type {any} */ t) => Math.max(m, t.width, t.height),
			0
		),
		textureMaxAfter: textures.reduce(
			(/** @type {number} */ m, /** @type {any} */ t) => Math.max(m, t.after.width, t.after.height),
			0
		),
		ktx2: textures.some((/** @type {any} */ t) => t.after.ktx2Bytes > 0),
		gpuBefore: report?.gpuBytesBefore ?? 0,
		gpuAfter: report?.gpuBytesAfter ?? 0,
		bytesBefore: report?.bytesBefore ?? bytes.byteLength,
		bytesAfter: report?.bytesAfter ?? bytes.byteLength,
		ms: report?.ms ?? 0
	};
	if (placed) {
		placed.userData = { ...(placed.userData ?? {}), optimized: { ...summary, at: Date.now() } };
		// the way back: the original FILE, held for the session (decimate's LRU)
		retainOriginal(placed.uuid, {
			file: source.file,
			extension: source.extension,
			name: source.label,
			bytes: bytes.byteLength
		});
	}
	lastOptimizedImport.set({
		name: source.label,
		summary,
		report,
		uuid: placed?.uuid ?? null,
		originalId: original?.id ?? null,
		optimizedId: optimizedItem?.id ?? null
	});
	return {
		parsed: next,
		summary,
		originalId: original?.id ?? null,
		optimizedId: optimizedItem?.id ?? null
	};
}

/**
 * The toast an optimized import ends with: the numbers, and "Keep original only".
 * @param {string} uuid the placed root @param {string} name @param {any} result maybeOptimizeImport's
 */
export function announceOptimized(uuid, name, result) {
	showToast(optimizeSummary(name, result.summary), [
		{ label: 'Keep original only', action: () => void keepOriginalOnly(uuid, result.optimizedId) },
		{ label: 'OK', action: () => {} }
	]);
}

/**
 * "Keep original only": the placed object goes back to the ORIGINAL file (same uuid, pose and
 * name, one undoable swap — fileHandler.restoreOriginalImport) and the optimized Library copy is
 * removed. @param {string} uuid @param {string | null} optimizedId
 */
export async function keepOriginalOnly(uuid, optimizedId) {
	const { restoreOriginalImport } = await import('./fileHandler.svelte');
	const ok = await restoreOriginalImport(uuid, {
		strip: ['optimized', 'lod'],
		label: 'Keep original model'
	});
	if (ok && optimizedId) await deleteItem(optimizedId);
	return ok;
}

/**
 * REIMPORT an asset under its (new) override: the original's bytes run through the engine again,
 * the optimized Library copy is replaced, and every placed object that came from this original
 * is swapped for the new result (same uuid and pose; one undo step each).
 * @param {string} originalHash
 * @returns {Promise<{swapped: number, item: any} | null>}
 */
export async function reimportAsset(originalHash) {
	/** @type {any} */
	const original = itemByHash(originalHash);
	if (!original) {
		showToast('The original file is not in the Library any more.');
		return null;
	}
	const blob = await itemBlob(original.id);
	if (!blob) {
		showToast("The original file's bytes are not on this device.");
		return null;
	}
	const ext = String(original.name.split('.').pop() ?? 'glb').toLowerCase();
	const name = original.name.replace(/\.\w+$/, '');
	const old = original.optimizedHash ? itemByHash(original.optimizedHash) : null;
	/** @type {any[]} */
	const targets = [];
	get(objectsGroup)?.traverse?.((/** @type {any} */ o) => {
		if (o.userData?.optimized?.source === originalHash) targets.push(o);
	});
	let swapped = 0;
	/** @type {any} */
	let produced = null;
	if (targets.length) {
		const { replaceImportFrom } = await import('./fileHandler.svelte');
		for (const live of targets) {
			const r = await replaceImportFrom(live.uuid, new File([blob], original.name), ext, name);
			if (!r) continue;
			swapped++;
			if (r.optimized) produced = r.optimized;
		}
	} else produced = await rebuildOnly(blob, ext, name);
	// the previous optimized copy goes when the new settings minted a different one, or none
	/** @type {any} */
	const now = itemByHash(originalHash);
	if (old && (!produced?.optimizedId || now?.optimizedHash !== old.hash)) await deleteItem(old.id);
	if (!produced?.optimizedId && now?.optimizedHash)
		patchRecord(now.id, { optimizedHash: undefined });
	showToast(
		'Reimported "' +
			name +
			'"' +
			(swapped
				? ' — ' + swapped + ' placed cop' + (swapped === 1 ? 'y' : 'ies') + ' updated'
				: '') +
			'.'
	);
	return { swapped, item: produced };
}

/** A reimport with nothing placed: run the engine and refresh the Library pair. @param {Blob} blob
 * @param {string} ext @param {string} name */
async function rebuildOnly(blob, ext, name) {
	const { parseModelFile } = await import('./fileHandler.svelte');
	const file = new File([blob], name + '.' + ext);
	const parsed = await parseModelFile(file, ext, []);
	const result = await maybeOptimizeImport(parsed, { file, extension: ext, label: name });
	disposeTree(result?.parsed?.root ?? parsed.root);
	return result;
}
