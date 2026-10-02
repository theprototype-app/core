// Module SDK — locomotion feature flags, mode reads, the peer roster, shared-scene create/move, flyTo.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { peers, userdata } from '../../stores/appStore';
import { objectsGroup, isVRMode, isLocked } from '../../stores/sceneStore';
import { get } from 'svelte/store';
import { addObjectsRef, objectActionsRef } from './refs.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkWorld(ctx) {
	return {
		/**
		 * 31 K1: what this core's locomotion understands, for a module to feature-detect before
		 * it publishes `userData.play.locomotion` / `play.bounds`. `boundedTeleport`: a
		 * `teleport: true` in Interact/Play lands only on walkable ground inside `play.bounds`
		 * (else the content bounds) and never through a wall; `worldGrab`: `worldGrab: true`
		 * gives the grips Edit's world gestures in Interact/Play. An older core has no object.
		 */
		locomotion: Object.freeze({ boundedTeleport: true, worldGrab: true }),
		/** In a VR session right now? (DEVX #6) @returns {boolean} */
		isVR() {
			return !!get(isVRMode);
		},
		/** Is Play mode active (the ▶ button / pointer lock)? Modules that only
		 * drive things in play gate on this. @returns {boolean} */
		isPlaying() {
			return get(isLocked) === true;
		},
		/** Connected peer ids (the replicated roster) — use it to free state a
		 * peer left behind. @returns {string[]} */
		peerIds() {
			return (/** @type {any[]} */ (get(userdata)) ?? []).map((entry) => entry[0]);
		},
		/**
		 * 21-E7.1 (DEVX #15's other half): the roster WITH NICKNAMES. `peerIds` answers who is
		 * here and nothing a player would recognise, which is what a leaderboard is blocked on -
		 * a table of peer ids is not a scoreboard.
		 *
		 * The name is the roster row's slot 1, replicated through the existing `userdata`
		 * message, so this is a READ of already-shared state and adds nothing to the wire. A
		 * peer who has not set one has an empty name; the id is offered as `label` so a caller
		 * never has to decide how to fall back.
		 * @returns {{id: string, name: string, label: string, me: boolean}[]}
		 */
		peerNames() {
			const myId = /** @type {any} */ (get(peers))?.peer?.id ?? '';
			return (/** @type {any[]} */ (get(userdata)) ?? [])
				.filter((entry) => !!entry?.[0])
				.map((entry) => {
					const id = String(entry[0]);
					const name = String(entry[1] ?? '');
					// a short id tail is far more use than the whole 36-character peer id
					return { id, name, label: name || 'peer ' + id.slice(0, 4), me: id === myId };
				});
		},
		/**
		 * DEVX #5: create objects in the SHARED scene, replicated exactly like a
		 * user typing the command. Returns the uuids that appeared, so you can
		 * position them (api.moveObject) or joint them together.
		 * @param {string} command e.g. '/create Box 1 1 1'
		 * @param {{at?: number[]}=} opts `at` places the object (replicated)
		 * @returns {Promise<string[]>}
		 */
		async create(command, opts) {
			const group = get(objectsGroup);
			const before = new Set((group?.children ?? []).map((/** @type {any} */ c) => c.uuid));
			if (opts?.at && addObjectsRef) addObjectsRef.spawnAtPoint(command, opts.at);
			else {
				const commands = await import('../commandsHandler.svelte');
				commands.sceneCommand(command);
			}
			return (get(objectsGroup)?.children ?? [])
				.filter((/** @type {any} */ c) => !before.has(c.uuid))
				.map((/** @type {any} */ c) => c.uuid);
		},
		/**
		 * DEVX #5: move/rotate/scale a shared object and tell every peer — the
		 * same `move` the editor sends. Omitted parts keep their current value.
		 * @param {string} uuid @param {{pos?: number[], rot?: number[], scale?: number[]}} to
		 */
		moveObject(uuid, to) {
			/** @type {any} */
			const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
			if (!object) return false;
			if (to?.pos) object.position.fromArray(to.pos);
			if (to?.rot) object.rotation.set(to.rot[0], to.rot[1], to.rot[2]);
			if (to?.scale) object.scale.fromArray(to.scale);
			object.updateMatrix();
			/** @type {any} */
			const peer = get(peers);
			peer?.send({
				type: 'move',
				uuid,
				pos: object.position.toArray(),
				rot: [object.rotation.x, object.rotation.y, object.rotation.z],
				scale: object.scale.toArray()
			});
			return true;
		},
		/** Fly the LOCAL editor camera somewhere (never replicated — the viewpoint
		 * is per-viewer). @param {number[]} position @param {number[]=} lookAt */
		flyTo(position, lookAt) {
			objectActionsRef?.flyTo(position, lookAt ?? position);
		}
	};
}
