import { get } from 'svelte/store';
import { peers, userdata } from '../../stores/appStore';
import { mutedPeers, toggleMutePeer } from '../voiceChat';
import { hiddenPeers, setPeerHidden } from '../peerHide';
import { removePeer, allowBack, blockedPeers, canModerate } from '../peerModeration';
import { copyLookOf, hasLook, peerName } from '../peerActions';

// Roadmap 55 A9 — THE PEER MENU IN A HEADSET: Tools ▸ People. DOM is invisible in VR, so the
// Users panel's menu becomes two radial rings: People (one sector per connected peer, plus
// "Allow back" for anyone blocked) and that person's ring — Mute voice, Hide, Copy their
// look, and for a moderator Remove ▸ (Remove / Remove and block; a ring of its own is the
// confirm step, since the desktop confirm dialog cannot be seen in a headset). Same actions
// and same rules as the desktop menu (peerModeration / peerHide / peerActions).
//
// The radial registry is HANDED IN (vrRadialMenu calls startPeopleRing from its builtins):
// importing it from here would close a cycle back into vrRadialMenu.

/** whose ring is open @type {string} */
let target = '';
export function peopleRingTarget() {
	return target;
}

/** @type {Set<string>} people:* / allow:* ids registered now */
const live = new Set();

/**
 * @param {{register: (e: any) => void, unregister: (id: string, group?: string) => void, pushRing: (r: string) => void, popRing: () => void}} radial
 */
export function startPeopleRing(radial) {
	const { register, unregister, pushRing, popRing } = radial;
	const openPeer = (/** @type {string} */ id) => {
		target = id;
		pushRing('peer');
	};
	const rebuild = () => {
		/** @type {any} */
		const pc = get(peers);
		const me = pc?.peer?.id;
		const want = new Map();
		/** @type {any[]} */ (get(userdata))
			.filter((u) => u[0] && u[0] !== me)
			.slice(0, 6)
			.forEach((u, i) =>
				want.set('people:' + u[0], { id: 'people:' + u[0], group: 'people', label: () => peerName(u[0]), icon: 'person-standing', order: i, action: () => openPeer(u[0]) })
			);
		get(blockedPeers)
			.slice(0, 2)
			.forEach((b, i) =>
				want.set('allow:' + b.peerId, {
					id: 'allow:' + b.peerId,
					group: 'people',
					label: 'Allow back ' + (b.name || b.peerId.slice(0, 6)),
					icon: 'check',
					order: 10 + i,
					visible: () => canModerate(),
					action: () => allowBack(b.peerId)
				})
			);
		for (const id of live) if (!want.has(id)) unregister(id, 'people');
		live.clear();
		for (const [id, entry] of want) {
			register(entry);
			live.add(id);
		}
	};

	register({ id: 'nav:people', group: 'tools', label: 'People', icon: 'users', order: 6 });
	// the person's own ring
	register({
		id: 'peer:mute',
		group: 'peer',
		label: () => (get(mutedPeers).includes(target) ? 'Unmute voice' : 'Mute voice'),
		icon: () => (get(mutedPeers).includes(target) ? 'volume-2' : 'mic-off'),
		order: 0,
		action: () => target && toggleMutePeer(target)
	});
	register({
		id: 'peer:hide',
		group: 'peer',
		label: () => (get(hiddenPeers).includes(target) ? 'Show again' : 'Hide'),
		icon: () => (get(hiddenPeers).includes(target) ? 'eye' : 'scan-eye'),
		order: 1,
		active: () => get(hiddenPeers).includes(target),
		action: () => target && setPeerHidden(target)
	});
	register({
		id: 'peer:look',
		group: 'peer',
		label: 'Copy their look',
		icon: 'palette',
		order: 2,
		disabled: () => !hasLook(target),
		action: () => target && copyLookOf(target)
	});
	register({ id: 'nav:peer-remove', group: 'peer', label: 'Remove…', icon: 'x', order: 3, visible: () => canModerate() });
	register({
		id: 'peer:remove',
		group: 'peer-remove',
		label: 'Remove',
		icon: 'x',
		order: 0,
		action: () => {
			if (target) removePeer(target, { block: false });
			popRing();
			popRing();
		}
	});
	register({
		id: 'peer:block',
		group: 'peer-remove',
		label: 'Remove and block',
		icon: 'x',
		order: 1,
		action: () => {
			if (target) removePeer(target, { block: true });
			popRing();
			popRing();
		}
	});
	rebuild();
	userdata.subscribe(rebuild);
	blockedPeers.subscribe(rebuild);
}
