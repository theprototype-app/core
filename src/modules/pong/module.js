import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalCamera } from '../../stores/sceneStore';
import { userdata } from '../../stores/appStore';

// Two-player pong on a table. Claim a paddle by clicking it (first two
// peers); your paddle follows your pointer over the table plane (~20/s
// updates). The peer who spawned the table simulates the ball and broadcasts
// pos/score at ~12 Hz — everyone else just applies. Win at 5 resets.

const GROUP_NAME = 'pong-module';
const HALF_W = 3; // x
const HALF_D = 1.8; // z
const TABLE_Y = 0.9;
const WIN_SCORE = 5;

/** @type {any} */ let apiRef = null;

let state = null; // {spawnerId, paddles: {left, right}, score: [l, r]}
let ball = { x: 0, z: 0, vx: 1.6, vz: 0.9 };
let lastSimTime = null;
let lastBallSent = 0;
let lastPaddleSent = 0;

function group() {
	return apiRef?.scene()?.getObjectByName(GROUP_NAME) ?? null;
}

function mirrorUserData() {
	const g = group();
	if (g && state) g.userData = { ...g.userData, ...state, ball: [ball.x, ball.z] };
}

/** @param {string} text */
function drawScore(text) {
	const g = group();
	const sprite = g?.getObjectByName('pong-score');
	if (!sprite) return;
	const canvas = sprite.userData.canvas;
	const context = canvas.getContext('2d');
	context.clearRect(0, 0, canvas.width, canvas.height);
	context.fillStyle = '#ffffff';
	context.font = 'bold 72px monospace';
	context.textAlign = 'center';
	context.fillText(text, canvas.width / 2, 90);
	sprite.material.map.needsUpdate = true;
}

function buildTable(spawnerId) {
	const scene = apiRef?.scene();
	if (!scene || scene.getObjectByName(GROUP_NAME)) return;
	const g = new THREE.Group();
	g.name = GROUP_NAME;

	const table = new THREE.Mesh(
		new THREE.BoxGeometry(HALF_W * 2 + 0.4, 0.1, HALF_D * 2 + 0.4),
		new THREE.MeshStandardMaterial({ color: 0x14532d })
	);
	table.position.y = TABLE_Y - 0.08;
	g.add(table);

	['left', 'right'].forEach((side) => {
		const paddle = new THREE.Mesh(
			new THREE.BoxGeometry(0.15, 0.15, 0.8),
			new THREE.MeshStandardMaterial({ color: side === 'left' ? 0x3b82f6 : 0xef4444 })
		);
		paddle.name = 'pong-paddle-' + side;
		paddle.userData.pongSide = side;
		paddle.position.set(side === 'left' ? -HALF_W + 0.2 : HALF_W - 0.2, TABLE_Y, 0);
		g.add(paddle);
	});

	const ballMesh = new THREE.Mesh(
		new THREE.SphereGeometry(0.09, 16, 12),
		new THREE.MeshStandardMaterial({ color: 0xfacc15 })
	);
	ballMesh.name = 'pong-ball';
	ballMesh.position.set(0, TABLE_Y, 0);
	g.add(ballMesh);

	const canvas = document.createElement('canvas');
	canvas.width = 256;
	canvas.height = 128;
	const sprite = new THREE.Sprite(
		new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true })
	);
	sprite.name = 'pong-score';
	sprite.userData.canvas = canvas;
	sprite.scale.set(1.6, 0.8, 1);
	sprite.position.set(0, TABLE_Y + 1.2, 0);
	g.add(sprite);

	scene.add(g);
	state = { spawnerId: spawnerId, paddles: { left: null, right: null }, score: [0, 0] };
	ball = { x: 0, z: 0, vx: 1.6, vz: 0.9 };
	lastSimTime = null;
	drawScore('0 : 0');
	mirrorUserData();
}

function removeTable() {
	const scene = apiRef?.scene();
	const g = group();
	if (g) scene.remove(g);
	state = null;
}

function resetBall(towardLeft) {
	ball = { x: 0, z: 0, vx: towardLeft ? -1.6 : 1.6, vz: (Math.random() < 0.5 ? 1 : -1) * 0.9 };
}

/** Spawner-side simulation, broadcast at ~12 Hz @param {number} dt */
function simulate(dt) {
	ball.x += ball.vx * dt;
	ball.z += ball.vz * dt;
	if (ball.z > HALF_D - 0.1) { ball.z = HALF_D - 0.1; ball.vz = -Math.abs(ball.vz); }
	if (ball.z < -HALF_D + 0.1) { ball.z = -HALF_D + 0.1; ball.vz = Math.abs(ball.vz); }

	const g = group();
	['left', 'right'].forEach((side) => {
		const paddle = g?.getObjectByName('pong-paddle-' + side);
		if (!paddle) return;
		const px = paddle.position.x;
		const nearX = side === 'left' ? ball.x < px + 0.2 && ball.x > px - 0.1 : ball.x > px - 0.2 && ball.x < px + 0.1;
		const movingIn = side === 'left' ? ball.vx < 0 : ball.vx > 0;
		if (nearX && movingIn && Math.abs(ball.z - paddle.position.z) < 0.5) {
			ball.vx = -ball.vx * 1.03; // rally speeds up a little
			ball.vz += (ball.z - paddle.position.z) * 1.2;
		}
	});

	let scored = null;
	if (ball.x > HALF_W + 0.3) { state.score[0]++; scored = 'left'; resetBall(false); }
	if (ball.x < -HALF_W - 0.3) { state.score[1]++; scored = 'right'; resetBall(true); }
	if (scored) {
		if (state.score[0] >= WIN_SCORE || state.score[1] >= WIN_SCORE) {
			apiRef.toast('Pong: ' + (state.score[0] >= WIN_SCORE ? 'blue' : 'red') + ' wins!');
			state.score = [0, 0];
		}
		drawScore(state.score[0] + ' : ' + state.score[1]);
		apiRef.send({ op: 'score', score: state.score });
		mirrorUserData();
	}

	const now = performance.now();
	if (now - lastBallSent > 80) {
		lastBallSent = now;
		apiRef.send({ op: 'ball', pos: [ball.x, ball.z] });
	}
	const ballMesh = g?.getObjectByName('pong-ball');
	if (ballMesh) ballMesh.position.set(ball.x, TABLE_Y, ball.z);
}

/** @param {'left'|'right'} side @param {number} z */
function setPaddleZ(side, z) {
	const paddle = group()?.getObjectByName('pong-paddle-' + side);
	if (paddle) paddle.position.z = Math.min(Math.max(z, -HALF_D + 0.4), HALF_D - 0.4);
}

function mySide() {
	const me = apiRef?.peerId();
	if (!state || !me) return null;
	if (state.paddles.left === me) return 'left';
	if (state.paddles.right === me) return 'right';
	return null;
}

// pointer over the table moves my paddle (~20/s)
const raycaster = new THREE.Raycaster();
const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TABLE_Y);
const planeHit = new THREE.Vector3();
function onPointerMove(event) {
	const side = mySide();
	if (!side) return;
	const now = performance.now();
	if (now - lastPaddleSent < 50) return;
	const camera = get(globalCamera);
	if (!camera) return;
	raycaster.setFromCamera(
		new THREE.Vector2(
			(event.clientX / window.innerWidth) * 2 - 1,
			-(event.clientY / window.innerHeight) * 2 + 1
		),
		camera
	);
	if (!raycaster.ray.intersectPlane(tablePlane, planeHit)) return;
	lastPaddleSent = now;
	setPaddleZ(side, planeHit.z);
	mirrorUserData();
	apiRef.send({ op: 'paddle', side: side, z: planeHit.z });
}

export default {
	id: 'pong',
	name: 'Pong',
	version: '1.0.0',
	/** @param {any} api */
	register(api) {
		apiRef = api;

		api.registerInteractiveGroup(GROUP_NAME);

		api.registerMenu('Pong: spawn / remove', () => {
			if (state) {
				removeTable();
				api.send({ op: 'remove' });
			} else {
				buildTable(api.peerId() ?? 'me');
				api.send({ op: 'spawn', spawnerId: api.peerId() });
			}
		});

		// claim a free paddle by clicking it
		api.registerClickHandler((object) => {
			const side = object.userData?.pongSide;
			if (!side || !state) return false;
			const me = api.peerId();
			if (!me || state.paddles[side]) return true; // taken — still consume the click
			state.paddles[side] = me;
			mirrorUserData();
			api.toast('You control the ' + side + ' paddle — move the mouse over the table');
			api.send({ op: 'claim', side: side, peerId: me });
			return true;
		});

		if (typeof window !== 'undefined') window.addEventListener('pointermove', onPointerMove);

		api.registerFrameTask(() => {
			if (!state || state.spawnerId !== api.peerId()) return;
			const now = performance.now() / 1000;
			if (lastSimTime == null) lastSimTime = now;
			const dt = Math.min(now - lastSimTime, 0.05);
			lastSimTime = now;
			simulate(dt);
		});

		api.onMessage((data) => {
			if (data.op === 'spawn') buildTable(data.spawnerId);
			else if (data.op === 'remove') removeTable();
			else if (data.op === 'claim') {
				if (state) {
					state.paddles[data.side] = data.peerId;
					mirrorUserData();
				}
			} else if (data.op === 'paddle') setPaddleZ(data.side, data.z);
			else if (data.op === 'ball') {
				ball.x = data.pos[0];
				ball.z = data.pos[1];
				const mesh = group()?.getObjectByName('pong-ball');
				if (mesh) mesh.position.set(ball.x, TABLE_Y, ball.z);
				mirrorUserData();
			} else if (data.op === 'score') {
				if (state) {
					state.score = data.score;
					drawScore(state.score[0] + ' : ' + state.score[1]);
					mirrorUserData();
				}
			}
		});

		// free paddles (or drop the table) when their peer leaves
		userdata.subscribe((users) => {
			if (!state) return;
			const alive = new Set((users ?? []).map((entry) => entry[0]));
			alive.add(api.peerId());
			if (state.spawnerId && !alive.has(state.spawnerId) && state.spawnerId !== api.peerId()) {
				removeTable();
				return;
			}
			['left', 'right'].forEach((side) => {
				if (state.paddles[side] && !alive.has(state.paddles[side])) {
					state.paddles[side] = null;
					mirrorUserData();
				}
			});
		});

		api.registerStateSync({
			getState: () => (state ? { ...state, ball: [ball.x, ball.z] } : null),
			applyState: (incoming) => {
				if (!incoming) return;
				buildTable(incoming.spawnerId);
				state.paddles = incoming.paddles;
				state.score = incoming.score;
				drawScore(state.score[0] + ' : ' + state.score[1]);
				if (incoming.ball) {
					ball.x = incoming.ball[0];
					ball.z = incoming.ball[1];
				}
				mirrorUserData();
			}
		});
	}
};
