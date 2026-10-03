// Module SDK — module messages between peers and late-joiner state sync.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { peers } from '../../stores/appStore';
import { get } from 'svelte/store';
import { messageHandlers, stateSyncs, arrayRemove } from './registries.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkNet(ctx) {
	const { moduleId, onDispose } = ctx;
	return {
		/** Handle messages other peers sent with api.send() @param {(data: any) => void} fn */
		onMessage(fn) {
			(messageHandlers[moduleId] ??= []).push(fn);
			onDispose(() => {
				const list = messageHandlers[moduleId];
				if (!list) return;
				arrayRemove(list, fn);
				if (!list.length) delete messageHandlers[moduleId];
			}, 'message');
		},
		/** Broadcast to all peers; arrives at their onMessage handlers @param {any} payload */
		send(payload) {
			/** @type {any} */
			const peer = get(peers);
			if (peer) peer.send({ type: 'module', moduleId, ...payload });
		},
		/**
		 * Late-joiner sync: getState() is sent to new peers on connect,
		 * applyState(state) applies it on their side.
		 * @param {{getState: () => any, applyState: (state: any) => void}} sync
		 */
		registerStateSync(sync) {
			stateSyncs[moduleId] = sync;
			onDispose(() => {
				if (stateSyncs[moduleId] === sync) delete stateSyncs[moduleId];
			}, 'stateSync', { key: 'stateSync' });
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkNet.surface = {
	onMessage: 'registers',
	send: 'action',
	registerStateSync: 'registers'
};
