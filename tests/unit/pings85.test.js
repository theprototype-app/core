// @ts-nocheck — scene fixtures built ad hoc (the checkJs rule for test fixtures)
// Roadmap 85 S2-S4: the ping log (pingCore), the wire row, a ping that follows its object, and the placement
// params on a real objectsGroup (placement.js): at a ping, backed onto a wall, standing on a table, facing a person.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

vi.mock('$lib/agent/agentMode.js', () => ({ agentRequested: () => false }));
vi.mock('$lib/inviteStore.js', () => ({ isAgentPeer: (id) => id === 'agent' }));
const people = { vr: [] };
vi.mock('$lib/connector/whereAreUsers.js', () => ({
	personWorldPosition: (who) => (who === 'me' ? { id: 'me', position: new THREE.Vector3(0, 1.6, 10) } : null),
	headsetPeople: () => people.vr,
	personRow: (who) =>
		who === 'me' ? { id: 'me', you: true, name: 'Ann', position: [0, 1.6, 10], floor: 0, forwardFlat: [0, 0, -1], right: [1, 0, 0] } : null,
	bodyOf: () => ({ eye: 1.6, height: 1.71, shoulder: 1.4, hip: 0.9, knee: 0.49, reach: 0.75, room: 3, assumed: false })
}));
vi.mock('$lib/pingAudio', () => ({ playPing: () => {} }));
vi.mock('../../src/lib/lockControl', () => ({ peerColor: () => '#f80' }));

const { objectsGroup } = await import('../../src/stores/sceneStore');
const { peers } = await import('../../src/stores/appStore');
const core = await import('../../src/lib/pingCore.js');
const ping = await import('../../src/lib/ping.js');
const { placeObject, surfaceQuaternion, floorUnder, comfortRefusal, withBodyUnits } = await import('../../src/lib/ai/placement.js');
const units = await import('../../src/lib/ai/bodyUnitsCore.js');
const comfort = await import('../../src/lib/vr/agentComfort.js');
const { runParkHooks } = await import('../../src/lib/parkHooks.js');
const { isPingMessage, logPing, findPing, PING_MIN_GAP, PING_LOG_PER_PEER, PING_LOG_TTL } = core;
const { validateWireMessage } = await import('../../src/lib/wireValidate.js');

const rec = (id, peer, time, extra = {}) => ({ id, peer, name: peer, time, pos: [0, 0, 0], ...extra });

describe('85b S2 ping log', () => {
	it('throttles a person, keeps a few each, expires', () => {
		let log = logPing([], rec('a', 'p', 1000), 1000).log;
		expect(logPing(log, rec('b', 'p', 1000 + PING_MIN_GAP - 1), 1100).added).toBe(false);
		expect(logPing(log, rec('c', 'q', 1001), 1001).added).toBe(true);
		for (let i = 1; i <= PING_LOG_PER_PEER + 2; i++) log = logPing(log, rec('x' + i, 'p', 1000 + i * 1000), 1000 + i * 1000).log;
		expect(log.filter((p) => p.peer === 'p')).toHaveLength(PING_LOG_PER_PEER);
		expect(logPing(log, rec('z', 'r', 1e9), 1e9 + PING_LOG_TTL).log.map((p) => p.id)).toEqual(['z']);
	});

	it('"latest" = my newest, else the newest person (never an agent)', () => {
		const log = [rec('m1', 'me', 1), rec('m2', 'me', 5), rec('o', 'other', 9), rec('ag', 'agent', 20)];
		expect(findPing(log, 'latest', 'me')?.id).toBe('m2');
		expect(findPing(log, 'latest', null, (id) => id === 'agent')?.id).toBe('o');
		expect(findPing(log, 'o', 'me')?.id).toBe('o');
		expect(findPing(log, 'nope', 'me')).toBe(null);
	});

	it('the wire row: the 87 fields, the optional on, nothing hostile', () => {
		const ok = { type: 'ping', id: 'abc', pos: [1, 2, 3], name: 'Ann', color: '#fff', sound: 'ding' };
		expect(validateWireMessage(ok)).toBe(true);
		expect(validateWireMessage({ ...ok, on: { uuid: '12345678-aaaa', local: [0, 1, 0], normal: [0, 0, 1] } })).toBe(true);
		// PeerJS binary packing turns an absent field into null: still a ping
		expect(validateWireMessage({ ...ok, uuid: null, on: null, color: null })).toBe(true);
		expect(isPingMessage({ ...ok, pos: [1, 2] })).toBe(false);
		expect(isPingMessage({ ...ok, on: { uuid: 'x y', local: [0, 0, 0] } })).toBe(false);
		expect(isPingMessage({ ...ok, on: { uuid: '12345678', local: [0, NaN, 0] } })).toBe(false);
		expect(isPingMessage({ ...ok, name: 'x'.repeat(201) })).toBe(false);
	});
});

let group;
let sent;
beforeEach(() => {
	const scene = new THREE.Scene();
	group = new THREE.Group();
	scene.add(group);
	objectsGroup.set(group);
	sent = [];
	peers.set({ peer: { id: 'me' }, send: (m) => sent.push(m), openedPeers: [] });
	ping.pingLog.set([]);
});

const box = (w, h, d, at = [0, 0, 0]) => {
	const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial());
	m.position.fromArray(at);
	group.add(m);
	m.updateWorldMatrix(true, true);
	return m;
};
/** the tools' transform path, recorded */
const applied = [];
const apply = (object, t) => {
	applied.push(t);
	object.position.fromArray(t.position);
	object.rotation.set(...t.rotation);
	object.updateWorldMatrix(true, true);
};

describe('85b S2 a ping follows the object it landed on', () => {
	it('records the surface in the object frame and sends it; a remote ping takes its sender from the connection', async () => {
		const table = box(2, 1, 2, [5, 0.5, 0]);
		const hit = new THREE.Raycaster(new THREE.Vector3(5, 5, 0), new THREE.Vector3(0, -1, 0)).intersectObject(table)[0];
		ping.sendPing(hit.point, undefined, hit);
		expect(sent[0].on.uuid).toBe(table.uuid);
		expect(sent[0].on.local).toEqual([0, 0.5, 0]);
		expect(sent[0].on.normal).toEqual([0, 1, 0]);
		table.position.x = 8;
		const w = ping.pingWorld(ping.recentPings()[0]);
		expect(w.point.x).toBeCloseTo(8);
		ping.applyPing({ id: 'r1', peerId: 'liar', name: 'B', pos: [0, 0, 0] }, 'bob');
		expect(ping.recentPings().find((p) => p.id === 'r1').peer).toBe('bob');
	});
});

describe('85b S2-S4 placement params', () => {
	beforeEach(() => applied.splice(0));

	it('at a ping on a table top: stands on it', () => {
		const table = box(2, 1, 2, [0, 0.5, 0]);
		ping.pingLog.set([rec('t', 'me', Date.now(), { pos: [0, 1, 0], on: { uuid: table.uuid, local: [0, 0.5, 0], normal: [0, 1, 0] } })]);
		const lamp = box(0.4, 0.6, 0.4);
		const r = placeObject(lamp, { at: { ping: 'latest' } }, apply);
		expect(r.warnings).toEqual([]);
		expect(r.placed).toMatchObject({ at: 't', standsOn: table.name || table.uuid });
		expect(lamp.position.y).toBeCloseTo(1.3);
	});

	it('align surface: backed onto a wall, upright, facing out', () => {
		const wall = box(4, 3, 0.2, [0, 1.5, -2]);
		ping.pingLog.set([rec('w', 'me', Date.now(), { pos: [0, 1.5, -1.9], on: { uuid: wall.uuid, local: [0, 0, 0.1], normal: [0, 0, 1] } })]);
		const painting = box(1, 0.8, 0.06);
		placeObject(painting, { at: { ping: 'w' }, align: 'surface' }, apply);
		expect(painting.position.z).toBeCloseTo(-1.87);
		expect(painting.position.y).toBeCloseTo(1.5);
		const front = new THREE.Vector3(0, 0, 1).applyQuaternion(painting.quaternion);
		expect(front.z).toBeCloseTo(1);
		const up = new THREE.Vector3(0, 1, 0).applyQuaternion(surfaceQuaternion(new THREE.Vector3(1, 0, 0)));
		expect(up.y).toBeCloseTo(1);
	});

	it('snap floor: onto the table under it, or the ground; never onto a roof above', () => {
		box(2, 1, 2, [0, 0.5, 0]);
		box(6, 0.2, 6, [0, 5, 0]); // a roof
		const cup = box(0.2, 0.2, 0.2, [0, 1.5, 0]);
		placeObject(cup, { snap: 'floor' }, apply);
		expect(cup.position.y).toBeCloseTo(1.1);
		const rock = box(1, 1, 1, [10, 3, 0]);
		const r = placeObject(rock, { snap: 'floor' }, apply);
		expect(r.placed.snapped).toBe('the ground');
		expect(rock.position.y).toBeCloseTo(0.5);
		expect(floorUnder(rock, group)).toBe(null);
	});

	it('face_user: yaw only, toward the person; a bad ping is a warning and moves nothing', () => {
		const sign = box(1, 1, 0.1, [0, 0.5, 0]);
		sign.rotation.x = 0.2;
		placeObject(sign, { face_user: true }, apply);
		const front = new THREE.Vector3(0, 0, 1).applyQuaternion(sign.quaternion);
		expect(front.z).toBeGreaterThan(0.9);
		expect(new THREE.Euler().setFromQuaternion(sign.quaternion, 'YXZ').x).toBeCloseTo(0.2);
		const n = applied.length;
		expect(placeObject(sign, { at: { ping: 'gone' } }, apply).warnings[0]).toMatch(/no such ping/);
		expect(applied.length).toBe(n);
	});
});

describe('85b S5 comfort', () => {
	it('the clear radius: head sphere, body column above the ankles', () => {
		const p = { head: { x: 0, y: 1.6, z: 0 }, feet: 0 };
		const b = (min, max) => ({ min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } });
		expect(core.comfortClash(b([-0.1, 1.5, -0.6], [0.1, 1.7, -0.3]), p)).toBe('head');
		expect(core.comfortClash(b([-0.1, 0.5, -0.2], [0.1, 0.7, -0.1]), p)).toBe('body');
		expect(core.comfortClash(b([-2, -0.1, -2], [2, 0.1, 2]), p)).toBe(null); // the floor under them
		expect(core.comfortClash(b([-0.1, 0.5, -1.6], [0.1, 0.7, -1.4]), p)).toBe(null); // 1.5 m ahead
	});

	it('only headset wearers count; the refusal names them', () => {
		const crate = box(1, 1, 1, [0, 0.5, 0]);
		people.vr = [];
		expect(comfortRefusal(crate)).toBe(null);
		people.vr = [{ id: 'q', name: 'Quinn', head: new THREE.Vector3(0, 1.6, 0.2), feet: 0 }];
		expect(comfortRefusal(crate)).toMatch(/inside Quinn's body/);
		people.vr = [];
	});

	it('a fade ends exactly where the material was, and a save mid-fade sees the real opacity', async () => {
		const m = box(1, 1, 1);
		m.material.opacity = 0.8;
		comfort.fadeIn(m);
		expect(m.material.opacity).toBe(0);
		expect(m.material.transparent).toBe(true);
		const restore = runParkHooks();
		expect(m.material.opacity).toBe(0.8);
		expect(m.material.transparent).toBe(false);
		restore();
		expect(m.material.opacity).toBe(0);
		await new Promise((r) => setTimeout(r, comfort.FADE_MS + 120));
		expect(m.material.opacity).toBe(0.8);
		expect(m.material.transparent).toBe(false);
	});
});

describe('85b S6 body units, S7 at a person', () => {
	it('proportions from the eye height; units in strings', () => {
		const b = units.bodyFrom(1.6);
		expect(b.hip).toBeCloseTo(0.91, 1);
		expect(units.bodyFrom(9).assumed).toBe(true);
		expect(units.resolveUnit('0.5 reach', b)).toBeCloseTo(b.reach / 2, 3);
		expect(units.resolveUnit('hips', b)).toBe(b.hip);
		expect(units.resolveUnit('2', b)).toBe('2');
		expect(units.specUsesUnits({ params: [1, 'hip', 1] })).toBe(true);
		expect(units.specUsesUnits({ params: [1, 2, 3] })).toBe(false);
		const r = withBodyUnits({ params: [1.2, 'hip', 0.8], position: [0, '0.5 hip', 0] });
		expect(r.spec.params).toEqual([1.2, 0.9, 0.8]);
		expect(r.spec.position[1]).toBe(0.45);
		expect(r.units).toEqual({ from: 'me' });
	});

	it('at {user}: ahead of them on their floor, facing them', () => {
		const stool = box(0.4, 0.5, 0.4);
		const r = placeObject(stool, { at: { user: 'me', ahead: 2 } }, apply);
		expect(r.placed.at).toBe('user Ann');
		expect(stool.position.toArray().map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.25, 8]);
		const front = new THREE.Vector3(0, 0, 1).applyQuaternion(stool.quaternion);
		expect(front.z).toBeGreaterThan(0.99);
		placeObject(stool, { at: { user: 'me', ahead: 0.1 } }, apply);
		expect(stool.position.z).toBeCloseTo(10 - 0.6);
	});
});
