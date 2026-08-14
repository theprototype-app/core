import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
// static like its sibling loaders: a lazy import of a three ADDON makes vite
// re-optimize deps on first use, which reloads the dev page mid-import (17-D2)
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { get } from 'svelte/store';
import { objectsGroup, TControls, selectedObject, selectedObjects } from '../stores/sceneStore.js';
import { sendObjects } from './commandsHandler.svelte';
import { recordObjectPresence } from '$lib/history';
// 17-D2: the .mtl texture path reuses the app's own downscale-to-dataURL step.
// STATIC on purpose — a lazy import of it from here never settled in dev, and
// materialsHandler does not import fileHandler, so this closes no cycle.
import { downscaleImage } from '$lib/materialsHandler';
import { originOf, bakeOriginForExport } from '$lib/objectOrigin';
import { bakeAnimationsForExport } from '$lib/animationPreview';
import { createGltfLoader, registerAnimatedImport, recordAnimatedImport, sendAnimatedImport } from '$lib/animatedImports';
import { environment } from './environment';
import { parkAnimatedAtBase } from '$lib/flowRuntime';
import { peers, fixLight, loadingFile, showToast } from '../stores/appStore';

//Access objects Store
let sceneObjects = $state();
objectsGroup.subscribe(value => { sceneObjects = value });

//Access object controls
let controls = $state();
TControls.subscribe(value => { controls = value });

//Access peers Store
let peer = $state();
peers.subscribe(value => { peer = value });

//loadingFile Store
let loadingNames = $state();
loadingFile.subscribe(value => { loadingNames = value });

// B3: .tpscene export prefs (set from the Sidebar export-settings cog)
export function tpsceneOptions() {
	const read = (/** @type {string} */ k, /** @type {boolean} */ dflt) => {
		const v = typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null;
		return v === null ? dflt : v === 'true';
	};
	return {
		assets: read('tpsceneAssets', true),
		packs: read('tpscenePacks', false),
		flow: read('tpsceneFlow', true)
	};
}

/** B3: save the scene as a .tpscene bundle (session.json + assets/ + packs/) */
async function saveTpScene() {
	const { buildSessionPayload, exportSessionZip } = await import('./sessions');
	const payload = buildSessionPayload('Scene export');
	const zip = await exportSessionZip(payload, tpsceneOptions());
	const blob = new Blob([zip], { type: 'application/zip' });
	const a = document.createElement('a');
	document.body.appendChild(a);
	a.style.display = 'none';
	const url = window.URL.createObjectURL(blob);
	a.href = url;
	const date = new Date().toISOString().replace(/[T:.Z]/g, '-');
	a.download = `ThePrototype-${date}UTC.tpscene`;
	a.click();
	window.URL.revokeObjectURL(url);
}

/** The selected objects (union of the primary selection + the multi-select set),
 * resolved to live Object3D roots for export. @returns {any[]} */
function selectedRoots() {
	const uuids = new Set(get(selectedObjects) || []);
	const primary = get(selectedObject);
	if (primary && primary.uuid) uuids.add(primary.uuid);
	const roots = [];
	for (const uuid of uuids) {
		const obj = sceneObjects?.getObjectByProperty('uuid', uuid);
		if (obj) roots.push(obj);
	}
	return roots;
}

/** Run the GLTFExporter over a root (or array of roots) and download it.
 * @param {string} format @param {any} input */
function exportGltf(format, input) {
	// saves store animation BASE poses, not the current swing (88)
	const restore = parkAnimatedAtBase();
	// 17-D: glTF nodes carry only TRS, so a per-object ORIGIN has to become real
	// geometry on the way out or the exported model pivots where it originally
	// did. Bake on CLONES — never the live objects, which would cost them their
	// parametric Geometry rows (meshgeo stamps faceEdited).
	const roots = Array.isArray(input) ? input : [input];
	let carriesOrigin = false;
	for (const root of roots)
		root?.traverse?.((/** @type {any} */ object) => {
			if (originOf(object)) carriesOrigin = true;
		});
	const payload = carriesOrigin
		? roots.map((root) => bakeOriginForExport(root.clone(true)))
		: input;
	// 17-E A7: authored keyframes are OUR channels, which nothing downstream
	// understands — sample them into real KeyframeTracks so the movement leaves
	// with the model. Baked from the LIVE roots (the origin clones have the pivot
	// folded into their geometry already, and the bake reads the same origin).
	const animations = roots.flatMap((root) => bakeAnimationsForExport(root));
	const exporter = new GLTFExporter();
	exporter.parse(
		payload,
		function (result) {
			restore();
			const blob = new Blob([JSON.stringify(result)], { type: 'application/json' });
			const a = document.createElement('a');
			document.body.appendChild(a);
			a.style.display = 'none';
			const url = window.URL.createObjectURL(blob);
			a.href = url;
			const date = new Date().toISOString().replace(/[T:.Z]/g, '-');
			a.download = `ThePrototype-${date}UTC.${String(format).toLowerCase()}`;
			a.click();
			window.URL.revokeObjectURL(url);
		},
		function (error) {
			restore();
			console.log(error);
		},
		animations.length ? { animations } : undefined
	);
}

export function save(format) {
	console.log('Saving...');
	if (format === 'tpscene') return void saveTpScene(); // B3: Scene bundle path
	// B1.2: GLTF exports the SELECTION (it used to export the whole scene). No
	// selection -> warn + offer the whole scene. JSON keeps its whole-scene behavior.
	if (String(format).toLowerCase() === 'gltf') {
		const roots = selectedRoots();
		if (roots.length) {
			exportGltf(format, roots);
			showToast(roots.length === 1 ? 'Exported 1 selected object (GLTF)' : `Exported ${roots.length} selected objects (GLTF)`);
		} else {
			showToast('Nothing selected — export the entire scene?', [
				{ label: 'Export all', action: () => exportGltf(format, sceneObjects) }
			]);
		}
		return;
	}
	// JSON (legacy, whole scene)
	exportGltf(format, sceneObjects);
}

export async function loadFile(url, name) {
	const reader = new FileReader();
	let blob = await fetch(url).then((r) => r.blob());
	return new Promise((resolve, reject) => {
	reader.readAsText(blob);
	reader.onload = function (event) {
		try {
			// console.log(`Loaded file: ${url}`);
			if (url.endsWith('.json')) {
				resolve(JSON.parse(event.target.result));
			} else if (url.endsWith('.html')) {
				resolve(event.target.result);
			} else if (url.endsWith('.glb')) {
				importFile(blob, name, 'glb');
			} else {
				console.error(`Unsupported file type: ${url}`);
				reject(new Error(`Unsupported file type: ${url}`));
			}
			let index = loadingNames.findIndex(x => x.id == name);
			if (index) loadingNames.splice(index,1);
			loadingFile.update((value) => value);
		} catch (error) {
			console.error(`Error loading file: ${url}`, error);
			reject(error);
		}}});
		
}

/**
 * Animated imports keep their file bytes and replicate as ONE objectfile
 * message (rigs cannot survive the per-node pipeline).
 * @param {any} result @param {ArrayBuffer} buffer @param {string=} name
 * @param {'gltf'|'fbx'=} kind which parser the bytes need on the other side (17-D2)
 */
function addAnimatedImport(result, buffer, name, kind) {
	const root = result.scene;
	root.name = name ?? 'Animated import';
	sceneObjects.add(root);
	objectsGroup.update((value) => value);
	controls.attach(root);
	registerAnimatedImport(root, result.animations, buffer, kind ?? 'gltf');
	recordAnimatedImport(root);
	sendAnimatedImport(peer, root);
	selectedObject.set(root);
	// 15-K3: the selection SET drives the outline + Ctrl+D — keep it in sync
	selectedObjects.set([root.uuid]);
	peer.send({ type: 'lock', uuid: root.uuid, peerId: peer.peer.id });
	showToast('Animated model: ' + result.animations.length + ' clip(s), playing the first');
}

/** Shared tail for every import format: add to the scene, select, replicate.
 * @param {any} imported @param {string=} name @param {number[]=} position drop point (96) */
function addImported(imported, name, position) {
	if (name) imported.name = name;
	// position BEFORE the sync so peers receive the placed transform (96)
	if (position) imported.position.fromArray(position);
	sceneObjects.add(imported);
	//Trigger reactivity for UI list of objects
	objectsGroup.update((value) => value);
	controls.attach(imported);
	recordObjectPresence('create', imported);
	sendObjects(/** @type {any} */ (null), imported);

	selectedObject.set(sceneObjects.getObjectByProperty('uuid', imported.uuid));
	// 15-K3: the selection SET drives the outline + Ctrl+D — keep it in sync
	selectedObjects.set([imported.uuid]);
	peer.send({ type: 'lock', uuid: imported.uuid, peerId: peer.peer.id });

	// the environment rig lights every preset except Classic — only nag about
	// missing lights there (same guard as /create in commandsHandler; imports
	// used to nag under ANY preset even though the scene was clearly lit)
	if (get(environment).preset === 'classic') {
		fixLight.set(true);
		sceneObjects.traverse((/** @type {any} */ object) => {
			if (object.isLight) {
				fixLight.set(false);
			}
		});
	}
}

/**
 * Import a GENERATED GLB (roadmap #11): parse the bytes, stamp AI provenance on the
 * root (survives GLTF sync + .tpscene), then place + replicate + record undo via the
 * SAME addImported path a dropped .glb uses. Returns the placed object's uuid.
 * @param {ArrayBuffer} buffer
 * @param {{name?: string, position?: number[], provenance?: any}} [opts]
 * @returns {Promise<string>}
 */
export function importGeneratedGlb(buffer, opts = {}) {
	return new Promise((resolve, reject) => {
		try {
			createGltfLoader().parse(
				buffer,
				'',
				(/** @type {any} */ result) => {
					try {
						const root = result.scene;
						if (opts.provenance) root.userData = { ...(root.userData || {}), aiGen: opts.provenance };
						if (result.animations?.length > 0) {
							// rare for generated meshes; animated rigs keep the raw-bytes path (unplaced)
							addAnimatedImport(result, buffer, opts.name ?? 'Generated');
						} else {
							addImported(root, opts.name ?? 'Generated', opts.position);
						}
						resolve(root.uuid);
					} catch (e) {
						reject(e instanceof Error ? e : new Error(String(e)));
					}
				},
				(/** @type {any} */ error) => reject(error instanceof Error ? error : new Error('GLB parse failed'))
			);
		} catch (e) {
			reject(e instanceof Error ? e : new Error(String(e)));
		}
	});
}

// ---- 17-D2: OBJ material libraries ---------------------------------------
// A .obj names its material library with `mtllib <file>` and the .mtl names its
// texture files — neither is inside the .obj, so both have to be handed over by
// the user (multi-select in the import dialog / a multi-file drop). Texture files
// are turned into DATA URLs first: a blob: URL would die with the page and could
// never reach a peer, while a data URL rides toJSON/GLTF sync like any other
// texture this app applies.

/** does this .obj reference a material library at all? @param {string} text */
function hasMtlReference(text) {
	return /^\s*mtllib\s+\S+/m.test(String(text ?? ''));
}

/** @param {any[]|undefined} extras @param {string} extension */
function companionsOf(extras, extension) {
	return (extras ?? []).filter((/** @type {any} */ f) =>
		String(f?.name ?? '').toLowerCase().endsWith('.' + extension)
	);
}

/**
 * Wire a material library into an OBJLoader when the .mtl came along.
 *
 * Texture references are resolved BEFORE parsing, by rewriting the .mtl text:
 * a `map_*` naming a companion image gets that image's data URL inlined, and a
 * `map_*` naming a file the user did not bring is DROPPED. Deciding here rather
 * than inspecting the parsed textures matters twice over — TextureLoader fills
 * `texture.image` asynchronously (so a post-parse check cannot tell "not loaded
 * yet" from "will never load"), and a texture left pointing at a missing file
 * aborts the object's own GLTF replication with "No valid image data found".
 *
 * @param {any} loader @param {any} objFile @param {any[]|undefined} extras
 * @returns {Promise<{applied: boolean, dropped: number, maps: Map<string,string>}>}
 */
async function applyObjMaterials(loader, objFile, extras) {
	const none = { applied: false, dropped: 0, maps: new Map() };
	const mtls = companionsOf(extras, 'mtl');
	if (!mtls.length) return none;
	const base = String(objFile?.name ?? '').toLowerCase().replace(/\.obj$/, '');
	// prefer the .mtl named after the .obj, else the only one supplied
	const mtl =
		mtls.find((/** @type {any} */ f) => String(f.name).toLowerCase().replace(/\.mtl$/, '') === base) ??
		mtls[0];
	try {
		/** @type {Map<string, string>} bare filename -> data URL */
		const textures = new Map();
		for (const file of extras ?? []) {
			if (!/\.(png|jpe?g|webp|bmp|gif)$/i.test(String(file?.name ?? ''))) continue;
			try {
				textures.set(String(file.name).toLowerCase(), await downscaleImage(file, 1024));
			} catch {
				/* unreadable image — that material just keeps its colour */
			}
		}
		/** @type {Map<string, string>} material name -> data URL (for userData) */
		const maps = new Map();
		let dropped = 0;
		let current = '';
		const rewritten = String(await readAs(mtl, 'text'))
			.split(/\r?\n/)
			.map((line) => {
				const named = line.match(/^\s*newmtl\s+(.+?)\s*$/);
				if (named) {
					current = named[1];
					return line;
				}
				const map = line.match(/^(\s*map_\w+\s+)(.+?)\s*$/);
				if (!map) return line;
				const tokens = map[2].split(/\s+/);
				const filename = String(tokens[tokens.length - 1]).split(/[\\/]/).pop()?.toLowerCase() ?? '';
				const dataUrl = textures.get(filename);
				if (!dataUrl) {
					dropped++;
					return null; // the image was not supplied — drop the reference
				}
				tokens[tokens.length - 1] = dataUrl;
				if (/^\s*map_kd/i.test(map[1]) && current) maps.set(current, dataUrl);
				return map[1] + tokens.join(' ');
			})
			.filter((line) => line !== null)
			.join('\n');
		const materials = new MTLLoader().parse(rewritten, '');
		materials.preload();
		loader.setMaterials(materials);
		return { applied: true, dropped, maps };
	} catch (error) {
		console.error('Could not read the .mtl material library', error);
		showToast('Could not read ' + (mtl?.name ?? '.mtl') + ' — importing the mesh without materials');
		return none;
	}
}

/**
 * Stamp each textured material's data URL where the Inspector thumbnail and the
 * texture-replication path look for it. Keyed by MATERIAL NAME from the .mtl, so
 * it does not depend on the texture having finished loading.
 * @param {any} root @param {Map<string,string>} maps material name -> data URL
 */
function stampImportedTextures(root, maps) {
	if (!maps.size) return;
	root.traverse((/** @type {any} */ object) => {
		const list = Array.isArray(object.material) ? object.material : [object.material];
		for (const material of list) {
			const dataUrl = material?.name ? maps.get(material.name) : null;
			if (dataUrl) material.userData = { ...(material.userData || {}), mapDataUrl: dataUrl };
		}
	});
}

/** @param {any} file @param {'text' | 'buffer'} mode */
function readAs(file, mode) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(reader.error);
		if (mode === 'text') reader.readAsText(file);
		else reader.readAsArrayBuffer(file);
	});
}

/** the model formats the import dialog and the viewport drop both accept */
export const MODEL_EXT = /\.(glb|gltf|obj|stl|fbx)$/i;
/** files that are not models themselves but belong to one (17-D2) */
export const COMPANION_EXT = /\.(mtl|png|jpe?g|webp|bmp|gif)$/i;

/**
 * Import a user's whole file SELECTION: every model file is imported, and the
 * non-model files ride along as companions (an .obj needs its .mtl and that
 * .mtl's textures — none of them are inside the .obj). 17-D2.
 * @param {any} list FileList or array
 * @returns {{models: number, companions: number, skipped: string[]}}
 */
export function importModelFiles(list) {
	const files = [...(list ?? [])];
	const models = files.filter((file) => MODEL_EXT.test(file.name ?? ''));
	const companions = files.filter((file) => COMPANION_EXT.test(file.name ?? ''));
	const skipped = files
		.filter((file) => !models.includes(file) && !companions.includes(file))
		.map((file) => file.name);
	models.forEach((file) =>
		importFile(file, file.name.replace(MODEL_EXT, ''), undefined, undefined, companions)
	);
	if (!models.length && companions.length)
		showToast('Select the model file too — a .mtl or texture cannot be imported on its own');
	if (skipped.length) showToast('Unsupported: ' + skipped.join(', '));
	return { models: models.length, companions: companions.length, skipped };
}

/**
 * Import a 3d file into the scene. GLB/GLTF, OBJ (+ .mtl when its companion file
 * comes along), STL and FBX (animated ones ride the raw-bytes path since 17-D2).
 * @param {any} file @param {string=} name @param {string=} ext - explicit extension when the blob has no name (Library)
 * @param {number[]=} position - world drop point (Explorer drag-out, 96)
 * @param {any[]=} extras - companion files picked/dropped alongside (.mtl + its textures)
 */
export async function importFile(file, name, ext, position, extras) {
	const extension = String(ext ?? file.name ?? '').toLowerCase().split('.').pop();
	try {
		if (extension === 'obj') {
			const text = await readAs(file, 'text');
			const loader = new OBJLoader();
			// 17-D2: an .obj carries no materials of its own — when the user brought
			// the .mtl along (multi-select in the import dialog, or a multi-file
			// drop), parse it and hand the material library to OBJLoader.
			const { applied, dropped, maps } = await applyObjMaterials(loader, file, extras);
			const object = loader.parse(text);
			// stamp BEFORE addImported — that call is what replicates the object
			stampImportedTextures(object, maps);
			addImported(object, name ?? 'OBJ', position);
			if (!applied && hasMtlReference(text))
				showToast('This .obj references a .mtl — pick both files together to import its materials');
			else if (dropped)
				showToast(
					dropped + ' texture(s) named by the .mtl were not included — add the image files to see them'
				);
		} else if (extension === 'stl') {
			const geometry = new STLLoader().parse(await readAs(file, 'buffer'));
			geometry.computeVertexNormals();
			const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xcccccc }));
			addImported(mesh, name ?? 'STL', position);
		} else if (extension === 'fbx') {
			const buffer = await readAs(file, 'buffer');
			const object = new FBXLoader().parse(buffer, '');
			// 17-D2: FBX clips used to be dropped on the floor (the loader parsed
			// them, nothing read them). Animated rigs now take the SAME raw-bytes
			// route as animated GLB — peers reparse the original file.
			if (object.animations?.length > 0)
				addAnimatedImport(
					{ scene: object, animations: object.animations },
					buffer,
					name ?? 'FBX',
					'fbx'
				);
			else addImported(object, name ?? 'FBX', position);
		} else {
			// glb/gltf (default) — draco/meshopt capable
			const buffer = await readAs(file, 'buffer');
			createGltfLoader().parse(
				buffer,
				'',
				(result) => {
					// animated rigs keep their own pipeline (raw-bytes sync) — unplaced
					if (result.animations?.length > 0) addAnimatedImport(result, buffer, name);
					else addImported(result.scene, name, position);
				},
				(error) => {
					console.error('Error importing file:', error);
					showToast('Could not import ' + (name ?? file.name ?? 'file'));
				}
			);
		}
	} catch (error) {
		console.error('Error importing file:', error);
		showToast('Could not import ' + (name ?? file.name ?? 'file') + ' — the file may be corrupt or an unsupported version');
	}
}

export async function load(file) {
try {
	// B3: .tpscene bundles restore assets + packs, then apply the session (the
	// request path confirms/proposes like the Sessions manager Load)
	if (file.name?.toLowerCase().endsWith('.tpscene')) {
		const { importSessionZip, requestLoadSession } = await import('./sessions');
		const payload = await importSessionZip(await file.arrayBuffer());
		if (!payload) return; // V4: user declined a newer-format confirm — silent
		await requestLoadSession(payload.id);
		return;
	}
	const reader = new FileReader();
	reader.readAsText(file);
	await new Promise((resolve, reject) => {
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(reader.error);
	});
	const json = JSON.parse(reader.result);
	const loader = new GLTFLoader();
	const result = await new Promise((resolve, reject) => {
		loader.parse(
			json,
			'',
			(gltf) => resolve(gltf),
			(error) => reject(error)
		);
	});

    if (file.name.split('.').pop() == 'gltf') {
    let uuids = []
    result.scene.children.forEach(object => {
      let mesh = object.clone()
      uuids.push(mesh.uuid)
      console.log(object.name)
      sceneObjects.add(mesh)
    });
    //Trigger reactivity for UI list of objects
    objectsGroup.update((value) => value);
    //Send object to peers
    peer.send({type: 'object', element: json, uuids: uuids})
    } else if (file.name.split('.').pop() == 'json') {
	//AuxScene is default name for GLTFExporter
	const childs = result.scene.getObjectByName('AuxScene').children[0].children;

	// adding objectArray as mid transition
	// otherwise the child becomes undefined after third iteration, causing an error
	let objectsArray = []; //initialize object array
	childs.forEach((child) => {
		objectsArray.push(child);
	});
	objectsArray.forEach((child) => {
		sceneObjects.add(child);
        //Send object to peers
        peer.send({type: 'object', element: child.toJSON()})
	});
	//Trigger reactivity for UI list of objects
	objectsGroup.update((value) => value);
	// Free memory by emptying the array
	objectsArray.length = 0;
	console.log('Scene load complete');
	return result;
}
} catch (error) {
    console.error('Error loading scene:', error);
}
}
