// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { customGeometryBuilders } from '../customGeometries';
import { compactSprite } from './spriteCore.js';
import { isViewer, warnViewerReadOnly } from '../objectPermissions';

// 64-2d (D4 wave 1): THE "2D SCENE" TEMPLATE, built in code (QUESTIONS Q2). The pixel art is drawn
// on canvases here, the objects are made with three and written with toJSON — the session
// format, so the template loads through the ordinary importSessionPayload → requestLoadSession
// path (consent, the backup stash, the replicated replace) and nothing about it is special
// afterwards: a saved copy is an ordinary .tpscene.
//
// What it holds — the wave-1 features, each one visible:
//   Sky        a 2D layer, parallax 0 (rides with the camera), z -10
//   Far hills  parallax 0.3, z -6           (the three layers ARE the parallax demo)
//   Trees      parallax 0.6, z -3
//   Gameplay   parallax 1, z 0: the ground and a PLAYER — a 4-frame sprite sheet whose `walk`
//              clip autoplays, walking back and forth on a Follow Path node
//   Camera     orthographic, z 10; its own graph has Camera Follow 2D (an Object Selector picks
//              the player); the scene graph's Game Start looks through it when a game starts.
// Layer parallax is horizontal only (parallaxY 1), so authored heights are drawn heights.

/** draw w×h pixels with `paint`, return the canvas @param {number} w @param {number} h @param {(g: CanvasRenderingContext2D) => void} paint */
function pixels(w, h, paint) {
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
	g.imageSmoothingEnabled = false;
	paint(g);
	return canvas;
}

/** a deterministic 0..1 sequence, so the art is the same on every load @param {number} seed */
function rng(seed) {
	let s = seed >>> 0;
	return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function skyArt() {
	return pixels(16, 9, (g) => {
		const bands = ['#2b3a67', '#33497a', '#3f5d8f', '#5378a6', '#6c94bc', '#8bb0cf', '#a9c8dd', '#c5dbe6', '#dde9ec'];
		bands.forEach((c, y) => {
			g.fillStyle = c;
			g.fillRect(0, y, 16, 1);
		});
		g.fillStyle = '#ffe9a8';
		g.fillRect(11, 2, 2, 2);
	});
}

function hillsArt() {
	return pixels(96, 16, (g) => {
		const r = rng(7);
		for (let x = 0; x < 96; x++) {
			const h = Math.round(7 + 4 * Math.sin(x / 9) + 2 * Math.sin(x / 3.7 + 1) + r());
			g.fillStyle = '#5b6f9a';
			g.fillRect(x, 16 - h, 1, h);
			g.fillStyle = '#6d82ad';
			g.fillRect(x, 16 - h, 1, 1);
		}
	});
}

function treesArt() {
	return pixels(128, 16, (g) => {
		const r = rng(11);
		g.fillStyle = '#2f5a4a';
		g.fillRect(0, 12, 128, 4);
		for (let x = 2; x < 126; x += 6 + Math.floor(r() * 6)) {
			const h = 6 + Math.floor(r() * 6);
			g.fillStyle = '#4a3a2c';
			g.fillRect(x + 1, 16 - 3, 1, 3);
			g.fillStyle = r() > 0.5 ? '#3d7a5c' : '#356d52';
			for (let i = 0; i < h; i++) {
				const w = Math.max(1, Math.round((i / h) * 4));
				g.fillRect(x + 1 - Math.floor(w / 2), 16 - 3 - h + i, w, 1);
			}
		}
	});
}

function groundArt() {
	return pixels(256, 8, (g) => {
		const r = rng(3);
		g.fillStyle = '#7a5a3a';
		g.fillRect(0, 0, 256, 8);
		g.fillStyle = '#5fa04e';
		g.fillRect(0, 0, 256, 2);
		g.fillStyle = '#4b8a3f';
		for (let x = 0; x < 256; x++) if (r() > 0.6) g.fillRect(x, 2, 1, 1);
		g.fillStyle = '#6b4e33';
		for (let i = 0; i < 60; i++) g.fillRect(Math.floor(r() * 256), 3 + Math.floor(r() * 5), 1, 1);
	});
}

/** a 4-frame walk cycle, 16×16 per frame, frames left to right */
function playerArt() {
	return pixels(64, 16, (g) => {
		for (let f = 0; f < 4; f++) {
			const ox = f * 16;
			const bob = f % 2;
			g.fillStyle = '#f2c79b'; // head
			g.fillRect(ox + 6, 2 + bob, 4, 4);
			g.fillStyle = '#2d2d2d'; // eye
			g.fillRect(ox + 9, 3 + bob, 1, 1);
			g.fillStyle = '#d9534f'; // shirt
			g.fillRect(ox + 5, 6 + bob, 6, 4);
			g.fillStyle = '#3b5998'; // legs, stepping
			const step = [0, 1, 0, -1][f];
			g.fillRect(ox + 6 + step, 10 + bob, 2, 5 - bob);
			g.fillRect(ox + 9 - step, 10 + bob, 2, 5 - bob);
		}
	});
}

/**
 * One sprite mesh from a canvas — the createGeometry 'Sprite' shape (unlit, alpha-tested, no
 * shadow) with the image as its map. @param {string} name @param {HTMLCanvasElement} canvas
 * @param {any} sprite the userData.sprite document @param {number[]} pos
 */
function spriteMesh(name, canvas, sprite, pos) {
	const doc = compactSprite(sprite);
	const ppu = sprite.ppu ?? 16;
	const cols = sprite.sheet?.cols ?? 1;
	const rows = sprite.sheet?.rows ?? 1;
	const plane = new THREE.PlaneGeometry(canvas.width / cols / ppu, canvas.height / rows / ppu);
	const geometry = new THREE.BufferGeometry().copy(plane);
	plane.dispose();
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	const material = new THREE.MeshBasicMaterial({ color: 0xffffff, map: texture, transparent: true, side: THREE.DoubleSide, alphaTest: 0.5 });
	material.userData.mapDataUrl = canvas.toDataURL('image/png');
	const mesh = new THREE.Mesh(geometry, material);
	mesh.name = name;
	mesh.position.fromArray(pos);
	mesh.userData.sprite = doc;
	mesh.userData.shadow = false;
	mesh.castShadow = false;
	return mesh;
}

/** @param {string} name @param {number} z @param {number} parallax */
function layer(name, z, parallax) {
	const group = new THREE.Group();
	group.name = name;
	group.position.set(0, 0, z);
	group.userData.layer2d = parallax === 1 ? { parallax: 1 } : { parallax, parallaxY: 1 };
	return group;
}

/**
 * The template as a session payload (the objects as toJSON, the graphs, an editor camera).
 * @param {{format: number, formatMinor: number, appVersion: string}} version the running app's
 * @returns {{payload: any, cameraUuid: string, playerUuid: string}}
 */
export function build2dTemplate(version) {
	const sky = layer('Sky (parallax 0)', -10, 0);
	sky.add(spriteMesh('Sky', skyArt(), { ppu: 0.8 }, [0, 0, 0]));
	const hills = layer('Far hills (parallax 0.3)', -6, 0.3);
	hills.add(spriteMesh('Hills', hillsArt(), { ppu: 2 }, [0, 1, 0]));
	const trees = layer('Trees (parallax 0.6)', -3, 0.6);
	trees.add(spriteMesh('Trees', treesArt(), { ppu: 4 }, [0, -0.5, 0]));
	const play = layer('Gameplay (parallax 1)', 0, 1);
	play.add(spriteMesh('Ground', groundArt(), { ppu: 4 }, [0, -2, 0]));
	const player = spriteMesh(
		'Player',
		playerArt(),
		{ ppu: 16, sheet: { cols: 4, rows: 1 }, clips: [{ name: 'walk', from: 0, to: 3, fps: 8 }], play: 'walk' },
		[0, -0.5, 0.1]
	);
	play.add(player);

	const camera = new THREE.Mesh(
		/** @type {any} */ (customGeometryBuilders).Camera(),
		new THREE.MeshStandardMaterial({ color: '#d8dee9', roughness: 0.5, metalness: 0.35 })
	);
	camera.name = '2D camera';
	camera.position.set(0, 1, 10);
	camera.userData.camera = { kind: 'orthographic', fov: 50, orthoSize: 5, near: 0.1, far: 100, aspect: '16:9', guide: true, pip: false };
	camera.userData.shadow = false;
	camera.castShadow = false;

	const node = (/** @type {string} */ id, /** @type {string} */ type, /** @type {any} */ data, /** @type {number} */ x, /** @type {number} */ y) => ({
		id,
		type,
		position: { x, y },
		data: { type, ...data }
	});
	const graphs = {
		scene: {
			nodes: [node('t2d-start', 'gamestart', { label: 'Game Start', camera: camera.uuid, state: 'playing' }, 0, 0)],
			edges: []
		},
		[player.uuid]: {
			nodes: [
				node('t2d-walk', 'followpath', {
					label: 'Follow Path',
					points: [
						[-14, -0.5, 0.1],
						[14, -0.5, 0.1]
					],
					speed: 2,
					mode: 'pingpong',
					closed: false,
					smooth: false,
					offset: 0,
					align: false,
					pitch: false,
					bank: 0,
					maxBank: 0,
					forward: '+z'
				}, 0, 0)
			],
			edges: []
		},
		[camera.uuid]: {
			nodes: [
				node('t2d-player', 'objectselector', { label: 'Object Selector', selected: player.uuid }, 0, 0),
				node('t2d-follow', 'follow2d', {
					label: 'Camera Follow 2D',
					deadW: 2,
					deadH: 1,
					ox: 0,
					oy: -1.5,
					damping: 0.2,
					followX: true,
					followY: false,
					bounds: true,
					minX: -24,
					maxX: 24,
					minY: -10,
					maxY: 10,
					ppu: 16
				}, 260, 0)
			],
			edges: [{ id: 't2d-e1', source: 't2d-player', target: 't2d-follow', targetHandle: 'target' }]
		}
	};
	const roots = [sky, hills, trees, play, camera];
	const payload = {
		id: crypto.randomUUID(),
		name: '2D scene',
		createdAt: Date.now(),
		format: version.format,
		formatMinor: version.formatMinor,
		appVersion: version.appVersion,
		count: roots.length,
		thumbnail: null,
		objects: roots.map((o) => o.toJSON()),
		animated: [],
		animations: {},
		graphs,
		nodes: graphs.scene.nodes,
		edges: graphs.scene.edges,
		camera: { position: [0, 1, 16], target: [0, 1, 0] }
	};
	for (const o of roots)
		o.traverse((/** @type {any} */ n) => {
			n.geometry?.dispose?.();
			n.material?.map?.dispose?.();
			n.material?.dispose?.();
		});
	return { payload, cameraUuid: camera.uuid, playerUuid: player.uuid };
}

/**
 * Open the 2D template: build it and load it the normal way (requestLoadPayload — the
 * replicated replace asks the room first; no slot appears in the Sessions manager), then open
 * the 2D editor view HERE.
 * @returns {Promise<boolean>} applied
 */
export async function open2dTemplate() {
	// viewers cannot replace the shared scene (the loadRemoteScene gate; inert without roles)
	if (isViewer()) {
		warnViewerReadOnly('View-only — ask an editor to load a scene.');
		return false;
	}
	const [sessions, { APP_VERSION }] = await Promise.all([import('../sessions'), import('../version.js')]);
	const { payload } = build2dTemplate({ format: sessions.SESSION_FORMAT, formatMinor: sessions.SESSION_FORMAT_MINOR, appVersion: APP_VERSION });
	const applied = await sessions.requestLoadPayload(payload);
	return !!applied;
}
