import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { carveAlongSpline, splineInFrameOf, CARVE_DEFAULTS } from './terrainCarve';
import { checkpointsFor } from './roadGates';
import { commitMeshGeoSnapshot } from './faceEdit';
import { beginHistoryBatch, endHistoryBatch } from './history';

// 21-C3/C4: THE CALLERS. terrainCarve.js and roadGates.js are pure leaves that
// compute; everything that touches the scene, the wire, the undo stack or a toast
// lives here. That split is what lets the maths be property-tested in node with no
// GL context, and it keeps both leaves out of history's import subtree.
//
// Reached through a dynamic import from objectMenu, the pattern the physics and
// terrainSculpt entries already use.

/** @param {string} uuid */
const objectOf = (uuid) => get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;

/**
 * Carve a road bed into a terrain along a spline. ONE meshgeo message and ONE
 * undo entry, positions-only: the carve moves Y and never adds or removes a
 * vertex, so groups and uvs carry over (commitMeshGeoTriple is for the ops that
 * change the triangle COUNT). What it does change is the REPRESENTATION — see the
 * toNonIndexed note in the body, which is not optional.
 *
 * @param {string} splineUuid @param {string} terrainUuid
 * @param {any=} options width / shoulder / mode / bankToCurve / clearance
 * @returns {boolean}
 */
export function carveRoadInto(splineUuid, terrainUuid, options = {}) {
	const road = objectOf(splineUuid);
	const terrain = objectOf(terrainUuid);
	if (!road?.userData?.spline?.points?.length) {
		showToast('That object is not a spline road');
		return false;
	}
	if (!terrain?.geometry?.attributes?.position) {
		showToast('That terrain has no geometry to carve');
		return false;
	}
	// the road's record lives in the ROAD's frame and the terrain has its own —
	// carving without this converts nothing and flattens the wrong strip
	const local = splineInFrameOf(road, terrain);
	if (!local) return false;
	const width = options.width ?? roadWidthOf(road);

	// THE MESHGEO CHANNEL CARRIES A TRIANGLE SOUP, NOT AN INDEXED MESH.
	// `applyMeshGeo` builds a fresh BufferGeometry with NO index, so handing it a
	// fresh Terrain's positions (2401 for 48 segments, 625 for 24) leaves three
	// drawing arbitrary triangles from consecutive triples — and 625 is not even
	// divisible by 3, so the last one is a fragment. The mesh shatters. Go
	// non-indexed FIRST, which is exactly what `enterSculpt` does before its own
	// first stroke, and then the count matches the previous index count, which is
	// the expansion case `preserveUVs` handles: the uvs come across intact.
	// (No separate representation message is needed the way enterSculpt needs one —
	// the commit below carries the whole soup, so peers rebuild the same one.)
	if (terrain.geometry.index) {
		const soup = terrain.geometry.toNonIndexed(); // carries uv + normal along
		terrain.geometry.dispose();
		terrain.geometry = soup;
	}
	const before = Array.from(terrain.geometry.attributes.position.array);
	const after = carveAlongSpline(terrain, local, { ...CARVE_DEFAULTS, ...options, width });
	if (!after) {
		showToast('Nothing to carve — a road needs at least two control points');
		return false;
	}
	let moved = 0;
	for (let i = 1; i < after.length; i += 3) if (Math.abs(after[i] - before[i]) > 1e-6) moved++;
	if (!moved) {
		// TWO very different situations produce zero MOVEMENT, and telling someone the
		// wrong one is worse than saying nothing: the road may not be over this tile at
		// all, or the bed may already be carved (carving twice is idempotent by
		// construction). `touched` — the count of vertices the road REACHED — is what
		// separates them, and it is why carveAlongSpline reports it.
		const reached = /** @type {any} */ (after).touched ?? 0;
		showToast(
			reached
				? `${terrain.name || 'That terrain'} is already carved along this road — nothing to change`
				: `${terrain.name || 'That terrain'} is not under this road — nothing changed`
		);
		return false;
	}
	const ok = commitMeshGeoSnapshot(terrainUuid, before, Array.from(after));
	if (ok) showToast(`Carved ${moved} vertices of ${terrain.name || 'the terrain'} — Ctrl+Z to undo`);
	return ok;
}

/** the road's own thickness IS its width: the tube's widest diameter, so a carve
 * defaults to the bed the visible road needs. @param {any} road */
function roadWidthOf(road) {
	const radii = (road?.userData?.spline?.points ?? []).map((/** @type {any} */ p) => p.radius ?? 0);
	const widest = radii.length ? Math.max(...radii) : 0;
	return widest > 0 ? widest * 2 : CARVE_DEFAULTS.width;
}

/**
 * Emit N sensor gate objects along a road. ZERO new node types: each gate is a
 * thin box with userData.physics = {collider:'box', sensor:true}, so the EXISTING
 * `onenter` node fires a replicated stamp per crossing and the EXISTING `counter`
 * node counts them — a lap system the user can see, wire and edit.
 *
 * Created through the replicated `/create` path (so peers build the same boxes
 * from the same command) and posed from the derived checkpoints. One undo batch.
 *
 * @param {string} splineUuid @param {number} count
 * @returns {Promise<string[]>} the gate uuids
 */
export async function createLapGates(splineUuid, count = 6) {
	const road = objectOf(splineUuid);
	const gates = checkpointsFor(road, count);
	if (!gates.length) {
		showToast('That object is not a spline road');
		return [];
	}
	// the replicated creation path a user typing the command takes, so peers build
	// the same boxes; then the editor's own `move` message poses them
	const commands = await import('./commandsHandler.svelte');
	const { setPhysicsFor } = await import('./physics');
	const { peers } = await import('../stores/appStore');
	/** @type {string[]} */
	const uuids = [];
	beginHistoryBatch();
	try {
		road.updateMatrixWorld(true);
		const point = new THREE.Vector3();
		const look = new THREE.Vector3();
		const quaternion = new THREE.Quaternion();
		const euler = new THREE.Euler();
		for (const gate of gates) {
			const group = get(objectsGroup);
			const before = new Set((group?.children ?? []).map((/** @type {any} */ c) => c.uuid));
			// a gate spans the road and stands up out of it; 0.3m thick so a fast car
			// cannot tunnel through it between two physics steps
			commands.sceneCommand(`/create Box ${gate.width.toFixed(2)} 2 0.3`);
			const fresh = (get(objectsGroup)?.children ?? []).find(
				(/** @type {any} */ c) => !before.has(c.uuid)
			);
			if (!fresh) continue;
			uuids.push(fresh.uuid);
			point.set(gate.position[0], gate.position[1], gate.position[2]);
			road.localToWorld(point);
			// face ALONG the road: aim the box's +Z down the tangent, flattened to the
			// ground plane so a gate never leans with a hill
			look.set(gate.tangent[0], 0, gate.tangent[2]);
			if (look.lengthSq() < 1e-8) look.set(0, 0, 1);
			look.normalize();
			quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), look);
			euler.setFromQuaternion(quaternion);
			fresh.position.set(point.x, point.y + 1, point.z);
			fresh.rotation.set(euler.x, euler.y, euler.z);
			fresh.updateMatrix();
			fresh.name = `Gate ${gate.index + 1}`;
			/** @type {any} */
			const peer = get(peers);
			peer?.send({
				type: 'move',
				uuid: fresh.uuid,
				pos: fresh.position.toArray(),
				rot: [fresh.rotation.x, fresh.rotation.y, fresh.rotation.z],
				scale: fresh.scale.toArray()
			});
			// a SENSOR is a trigger volume: pass-through, and it fires
			// fireObjectEnter/Exit, which is what the onenter node listens to
			// 'static' is the immovable body kind here ('fixed' is rapier's word for it,
			// not this app's); a sensor is pass-through either way
			setPhysicsFor(fresh.uuid, { mode: 'static', collider: 'box', sensor: true });
		}
	} finally {
		endHistoryBatch('Lap gates');
	}
	objectsGroup.update((value) => value);
	if (uuids.length)
		showToast(`${uuids.length} gates along the road — wire one to On Enter ▸ Counter for laps`);
	return uuids;
}
