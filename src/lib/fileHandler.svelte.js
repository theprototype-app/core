import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { objectsGroup, TControls, selectedObject } from '../stores/sceneStore.js';
import { sendObjects } from './commandsHandler.svelte';
import { recordObjectPresence } from '$lib/history';
import { createGltfLoader, registerAnimatedImport, recordAnimatedImport, sendAnimatedImport } from '$lib/animatedImports';
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

export function save(format) {
	console.log('Saving...');
	if (format === 'tpscene') return void saveTpScene(); // B3: Scene bundle path
	//This exports entire scene with all objects
	// saves store animation BASE poses, not the current swing (88)
	const restore = parkAnimatedAtBase();
	const exporter = new GLTFExporter({outputEncoding: format});
	exporter.parse(
		sceneObjects,
		function (result) {
			restore();
			var blob = new Blob([JSON.stringify(result)], { type: 'application/json' });
			let a = document.createElement('a');
			document.body.appendChild(a);
			a.style = 'display: none';
			let url = window.URL.createObjectURL(blob);
			a.href = url;
			let date = new Date().toISOString().replace(/[T:.Z]/g, '-');
			a.download = `ThePrototype-${date}UTC.${format.toLocaleLowerCase()}`;
			a.click();
			window.URL.revokeObjectURL(url);
		},
		function (error) {
			restore();
			console.log(error);
		}
	);
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
 */
function addAnimatedImport(result, buffer, name) {
	const root = result.scene;
	root.name = name ?? 'Animated import';
	sceneObjects.add(root);
	objectsGroup.update((value) => value);
	controls.attach(root);
	registerAnimatedImport(root, result.animations, buffer);
	recordAnimatedImport(root);
	sendAnimatedImport(peer, root);
	selectedObject.set(root);
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
	peer.send({ type: 'lock', uuid: imported.uuid, peerId: peer.peer.id });

	fixLight.set(true);
	sceneObjects.traverse((/** @type {any} */ object) => {
		if (object.isLight) {
			fixLight.set(false);
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

/**
 * Import a 3d file into the scene. GLB/GLTF, OBJ (no .mtl), STL and FBX (static meshes).
 * @param {any} file @param {string=} name @param {string=} ext - explicit extension when the blob has no name (Library)
 * @param {number[]=} position - world drop point (Explorer drag-out, 96)
 */
export async function importFile(file, name, ext, position) {
	const extension = String(ext ?? file.name ?? '').toLowerCase().split('.').pop();
	try {
		if (extension === 'obj') {
			const object = new OBJLoader().parse(await readAs(file, 'text'));
			addImported(object, name ?? 'OBJ', position);
		} else if (extension === 'stl') {
			const geometry = new STLLoader().parse(await readAs(file, 'buffer'));
			geometry.computeVertexNormals();
			const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xcccccc }));
			addImported(mesh, name ?? 'STL', position);
		} else if (extension === 'fbx') {
			const object = new FBXLoader().parse(await readAs(file, 'buffer'), '');
			addImported(object, name ?? 'FBX', position);
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
