// 74 VH3: THE AGENT PRESENCE MARKER. An AI agent in the session has no body (decision
// 2026-10-24), so nobody could tell WHERE it was working: objects just changed. This puts a small
// bot icon and the agent's name over the object it last edited, on every peer, in the editor and
// in a headset alike, and fades it while the agent is idle.
//
// Nothing new travels. The edits already replicate; `tapAgentEdit` reads each one as it is
// applied (peerHandler's dispatch, after every gate, so a dropped message moves no marker) and
// keeps only the sender's last place. Who is an agent comes from the roster row's slot 6
// (`{kind: 'agent'}`, 55's contract), so a person's edits never draw one.
//
// The sprite is a scene-root HELPER (markHelper): it hides in Play and in clean recordings like
// every editor helper, and the XR camera inherits the helper layer from the editor camera.
// LOCAL switch: `agents:cameraMarker` (55's "show agent markers" key) — 'false' hides it.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { userdata } from '../stores/appStore';
import { globalScene, objectsGroup } from '../stores/sceneStore';
import { safeStorage } from './safeStorage';
import { markHelper } from './helperLayer';
import { drawLucide } from './vr/icons.js';
import { editTargetOf, isAgentRow, agentLabel, markerOpacity, markerPointOf, markerScale, isIdle } from './agentPresenceCore.js';

export const MARKER_PREF = 'agents:cameraMarker';
const CHECK_MS = 200;
const PX_W = 512;
const PX_H = 128;
/** world height of the sprite at scale 1 */
const ASPECT = PX_W / PX_H;

/**
 * @typedef {{peerId: string, uuid: string | null, point: [number, number, number] | null,
 *   at: number, label: string, sig: string, sprite: THREE.Sprite | null,
 *   g: CanvasRenderingContext2D | null, texture: THREE.CanvasTexture | null, object: any}} Marker
 */

/** @type {Map<string, Marker>} */
const markers = new Map();
let lastCheck = -Infinity;
/** @type {THREE.Group | null} */
let root = null;
const _box = new THREE.Box3();
const _pos = new THREE.Vector3();
const debug = { taps: 0, draws: 0, ticks: 0 };

/** @param {string} peerId */
function rosterRow(peerId) {
	const rows = /** @type {any[]} */ (get(userdata) || []);
	return rows.find((r) => Array.isArray(r) && r[0] === peerId) || null;
}

/** is the marker switched on here? (LOCAL) */
export function agentMarkersOn() {
	return safeStorage.getItem(MARKER_PREF) !== 'false';
}

/**
 * An applied message from `peerId`: if it is an edit and the sender is an agent, the agent is
 * working there now. Called for every message, so the type test comes first.
 * @param {string} peerId @param {any} data
 */
export function tapAgentEdit(peerId, data) {
	const target = editTargetOf(data);
	if (!target) return;
	const row = rosterRow(peerId);
	if (!isAgentRow(row)) return;
	debug.taps++;
	let m = markers.get(peerId);
	if (!m) {
		m = { peerId, uuid: null, point: null, at: 0, label: agentLabel(row), sig: '', sprite: null, g: null, texture: null, object: null };
		markers.set(peerId, m);
	}
	m.at = Date.now();
	if ('uuid' in target && target.uuid !== m.uuid) {
		m.uuid = target.uuid;
		m.object = null;
	}
	lastCheck = -Infinity; // show the change on the next frame, not after the throttle
}

/**
 * The seam for an agent that is LOOKING rather than editing (55's agentview: camera pose → a
 * point in front of it, see `viewFocus`). agentLog.applyAgentView calls it for every agentview.
 * @param {string} peerId @param {[number, number, number]} point
 */
export function noteAgentFocus(peerId, point) {
	const row = rosterRow(peerId);
	if (!isAgentRow(row) || !Array.isArray(point)) return;
	let m = markers.get(peerId);
	if (!m) {
		m = { peerId, uuid: null, point: null, at: 0, label: agentLabel(row), sig: '', sprite: null, g: null, texture: null, object: null };
		markers.set(peerId, m);
	}
	m.uuid = null;
	m.object = null;
	m.point = [point[0], point[1], point[2]];
	m.at = Date.now();
	lastCheck = -Infinity;
}

/** @param {Marker} m */
function dispose(m) {
	if (m.sprite) {
		m.sprite.parent?.remove(m.sprite);
		/** @type {any} */ (m.sprite.material).dispose();
	}
	m.texture?.dispose();
	m.sprite = null;
	m.texture = null;
	m.g = null;
}

/** @param {any} scene */
function ensureRoot(scene) {
	if (root && root.parent === scene) return root;
	root = new THREE.Group();
	root.name = 'agent-presence';
	root.userData.__helper = true;
	scene.add(root);
	return root;
}

/** @param {Marker} m @param {string} objectName @param {boolean} idle */
function draw(m, objectName, idle) {
	const sub = objectName ? (idle ? 'was editing ' : 'editing ') + objectName : idle ? 'idle' : 'working';
	const sig = m.label + '|' + sub;
	if (sig === m.sig && m.sprite) return;
	m.sig = sig;
	if (!m.g) {
		const canvas = document.createElement('canvas');
		canvas.width = PX_W;
		canvas.height = PX_H;
		m.g = canvas.getContext('2d');
		m.texture = new THREE.CanvasTexture(canvas);
		m.texture.colorSpace = THREE.SRGBColorSpace;
		const material = new THREE.SpriteMaterial({ map: m.texture, transparent: true, depthTest: false, depthWrite: false });
		m.sprite = new THREE.Sprite(material);
		m.sprite.name = 'agent-marker';
		m.sprite.renderOrder = 999;
		m.sprite.center.set(0.5, 0);
		m.sprite.userData.agentMarker = m.peerId;
		markHelper(m.sprite);
	}
	const g = /** @type {CanvasRenderingContext2D} */ (m.g);
	g.clearRect(0, 0, PX_W, PX_H);
	// the pill
	const h = 84;
	const y = 8;
	g.font = '600 34px system-ui, sans-serif';
	const nameW = g.measureText(m.label).width;
	g.font = '26px system-ui, sans-serif';
	const subW = g.measureText(sub).width;
	const w = Math.min(PX_W - 8, 104 + Math.max(nameW, subW) + 24);
	const x = (PX_W - w) / 2;
	g.fillStyle = 'rgba(17, 24, 39, 0.88)';
	g.strokeStyle = idle ? 'rgba(148, 163, 184, 0.9)' : 'rgba(167, 139, 250, 1)';
	g.lineWidth = 4;
	g.beginPath();
	g.roundRect(x, y, w, h, h / 2);
	g.fill();
	g.stroke();
	// the pointer down to the object
	g.fillStyle = g.strokeStyle;
	g.beginPath();
	g.moveTo(PX_W / 2 - 12, y + h);
	g.lineTo(PX_W / 2 + 12, y + h);
	g.lineTo(PX_W / 2, PX_H - 2);
	g.closePath();
	g.fill();
	// the icon
	g.save();
	g.translate(x + 22, y + 14);
	g.scale(56 / 24, 56 / 24);
	g.strokeStyle = idle ? '#cbd5e1' : '#c4b5fd';
	g.lineWidth = 2;
	g.lineCap = 'round';
	g.lineJoin = 'round';
	drawLucide(g, 'bot');
	g.restore();
	// name + what it is doing
	g.textBaseline = 'alphabetic';
	g.fillStyle = '#f8fafc';
	g.font = '600 34px system-ui, sans-serif';
	g.fillText(fitText(g, m.label, w - 120), x + 96, y + 38);
	g.fillStyle = '#cbd5e1';
	g.font = '26px system-ui, sans-serif';
	g.fillText(fitText(g, sub, w - 120), x + 96, y + 70);
	/** @type {THREE.CanvasTexture} */ (m.texture).needsUpdate = true;
	debug.draws++;
}

/** @param {CanvasRenderingContext2D} g @param {string} text @param {number} max */
function fitText(g, text, max) {
	if (g.measureText(text).width <= max) return text;
	let t = text;
	while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
	return t + '…';
}

/** the marker's object, resolved by uuid (cached; re-found when it leaves the scene) @param {Marker} m */
function objectOf(m) {
	if (!m.uuid) return null;
	if (m.object && m.object.parent) return m.object;
	/** @type {any} */
	const group = get(objectsGroup);
	m.object = group?.getObjectByProperty?.('uuid', m.uuid) || null;
	return m.object;
}

/**
 * Per frame (Scene's useTask, which also runs in XR): place, fade and size every marker.
 * @param {any} camera @param {number} [now]
 */
export function tickAgentMarkers(camera, now = Date.now()) {
	if (!markers.size && !root) return;
	const scene = get(globalScene);
	if (!scene) return;
	const t = performance.now();
	const check = t - lastCheck >= CHECK_MS;
	if (check) {
		lastCheck = t;
		debug.ticks++;
		const on = agentMarkersOn();
		for (const m of [...markers.values()]) {
			const row = rosterRow(m.peerId);
			// left the session (or is no longer an agent): the marker goes with it
			if (!isAgentRow(row)) {
				dispose(m);
				markers.delete(m.peerId);
				continue;
			}
			m.label = agentLabel(row);
			const object = objectOf(m);
			if (object) {
				_box.setFromObject(object);
				const p = markerPointOf(_box);
				if (p) m.point = p;
			}
			if (!on || !m.point) {
				if (m.sprite) m.sprite.visible = false;
				continue;
			}
			draw(m, object ? object.name || object.type || '' : '', isIdle(now - m.at));
			const sprite = /** @type {THREE.Sprite} */ (m.sprite);
			if (sprite.parent !== ensureRoot(scene)) root?.add(sprite);
			sprite.position.set(m.point[0], m.point[1], m.point[2]);
			sprite.visible = true;
		}
		if (!markers.size && root) {
			root.parent?.remove(root);
			root = null;
		}
	}
	// every frame: opacity and a screen-steady size (cheap)
	if (camera?.getWorldPosition) camera.getWorldPosition(_pos);
	for (const m of markers.values()) {
		const sprite = m.sprite;
		if (!sprite || !sprite.visible) continue;
		/** @type {any} */ (sprite.material).opacity = markerOpacity(now - m.at);
		const s = markerScale(camera ? sprite.position.distanceTo(_pos) : 3);
		sprite.scale.set(s * ASPECT * 0.5, s * 0.5, 1);
	}
}

/** Debug hook (suites): what every marker is doing right now. */
export function agentPresenceDebug() {
	const now = Date.now();
	return {
		on: agentMarkersOn(),
		...debug,
		markers: [...markers.values()].map((m) => ({
			peerId: m.peerId,
			label: m.label,
			uuid: m.uuid,
			point: m.point,
			visible: !!m.sprite?.visible && !!m.sprite?.parent,
			opacity: m.sprite ? /** @type {any} */ (m.sprite.material).opacity : 0,
			idle: isIdle(now - m.at),
			sinceMs: now - m.at,
			sig: m.sig,
			layer: m.sprite ? m.sprite.layers.mask : 0
		}))
	};
}

/** Suites: pretend the last edit was `ms` ago (to see the fade without waiting 30 s). */
export function ageAgentMarkersForTest(/** @type {number} */ ms) {
	for (const m of markers.values()) m.at = Date.now() - ms;
	lastCheck = -Infinity;
}

/** Suites: the marker sprite's canvas as a data URL (to look at it). @param {string} peerId */
export function agentMarkerImage(peerId) {
	const m = markers.get(peerId);
	return m?.g ? m.g.canvas.toDataURL('image/png') : null;
}
