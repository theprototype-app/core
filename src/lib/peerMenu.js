// Roadmap 55 A9 — THE PEER MENU, as data (the `buildObjectMenuItems` shape: the Users panel
// and the VR Users panel render the SAME list, so neither can drift). Imports nothing — the
// caller hands in what it knows about the peer and the actions to run, and a unit test can
// ask "what does an editor see on a guest's row" without a browser.
//
// Grouped as the roadmap names them: Profile · Find · Character · Talk · For you only ·
// Moderation (admins on cloud builds, the session host in the OSS build) · the AI agent's
// extras · and, on your OWN row, Edit profile / Change character.
//
// A control that cannot act RIGHT NOW is disabled WITH the reason (21-G5's rule); one that
// can never act for this person is not offered at all.

/**
 * @typedef {{
 *   peerId: string, name: string, self: boolean,
 *   canModerate: boolean, canChangeRole: boolean,
 *   muted: boolean, hidden: boolean, away: string, privateRow: boolean,
 *   hasAvatar: boolean, editingUuid: string, hasLook: boolean,
 *   isAgent: boolean, inviteId: string, requestAsked: boolean, canInvite: boolean,
 *   watching: boolean, agentBusy?: boolean, agentMuted?: boolean,
 *   agentTools?: {id: string, name: string, panel: boolean}[], viewerMe?: boolean
 * }} PeerMenuFacts
 * @typedef {Record<string, ((...args: any[]) => void) | undefined>} PeerMenuActions
 */

/**
 * @param {PeerMenuFacts} f @param {PeerMenuActions} a
 * @returns {any[]} ContextMenu items (`section` rows head each group; `testid` on each row)
 */
export function buildPeerMenuItems(f, a) {
	/** @type {any[]} */
	const items = [];
	const row = (/** @type {string} */ testid, /** @type {string} */ label, /** @type {string} */ icon, /** @type {(() => void) | undefined} */ action, /** @type {any} */ extra = {}) =>
		items.push({ testid: 'peer-menu-' + testid, label, icon, action: action ?? (() => {}), ...extra });
	const off = (/** @type {string} */ why) => ({ disabled: true, tooltip: why });

	if (f.self) {
		items.push({ section: 'You' });
		row('edit-profile', 'Edit profile', 'settings', a.editProfile);
		row('change-character', 'Change character', 'person-standing', a.changeCharacter);
		row('copy-id', 'Copy peer id', 'copy', a.copyId);
		return items;
	}

	items.push({ section: 'Profile' });
	row('profile', 'View profile', 'user-round', a.viewProfile);
	row('copy-id', 'Copy peer id', 'copy', a.copyId);

	items.push({ section: 'Find' });
	if (f.privateRow) {
		row('goto', 'Go to', 'locate-fixed', a.goTo, off('In a private scene — ask them to share it first'));
	} else if (f.away) {
		row('goto', 'Go to', 'locate-fixed', a.goToScene, { tooltip: 'In ' + f.away + ' — travel to their scene' });
	} else if (f.hidden) {
		row('goto', 'Go to', 'locate-fixed', a.goTo, off('You hid them — show them again first'));
	} else if (!f.hasAvatar) {
		row('goto', 'Go to', 'locate-fixed', a.goTo, off('Their avatar is not in the scene yet'));
	} else {
		row('goto', 'Go to', 'locate-fixed', a.goTo, { tooltip: 'Fly your camera to them' });
	}
	const watchWhy = f.privateRow ? 'In a private scene' : f.away ? 'In ' + f.away + ' — go there to watch them' : f.hidden ? 'You hid them — show them again first' : '';
	row('watch', f.watching ? 'Watching' : 'Watch', 'eye', a.watch, watchWhy ? off(watchWhy) : { checked: f.watching });
	row('editing', 'Show what they’re editing', 'square-mouse-pointer', a.showEditing, f.editingUuid ? {} : off('They have nothing selected'));

	items.push({ section: 'Character' });
	row('character', 'View character', 'person-standing', a.viewCharacter);
	row('copy-look', 'Copy their look', 'palette', a.copyLook, f.hasLook ? { tooltip: 'Wear their character and colours' } : off('They wear the default look'));

	items.push({ section: 'Talk' });
	row('mute', f.muted ? 'Unmute voice' : 'Mute voice', f.muted ? 'volume-2' : 'volume-x', a.toggleMute, { tooltip: 'For you only' });
	if (f.privateRow) row('request-access', f.requestAsked ? 'Access requested' : 'Request access', 'message-square', a.requestAccess, f.requestAsked ? off('Asked — they decide') : {});
	if (f.canInvite) row('invite', 'Ask to join my scene', 'message-square', a.invite);

	items.push({ section: 'For you only' });
	row('hide', f.hidden ? 'Show again' : 'Hide', f.hidden ? 'eye' : 'eye-off', a.toggleHide, {
		tooltip: f.hidden ? 'Draw their avatar, cursor and voice again' : 'Hide their avatar, cursor and voice on your screen — they are not told'
	});

	if (f.canModerate) {
		items.push({ section: 'Moderation' });
		if (f.canChangeRole) row('role', 'Change role…', 'user-lock', a.changeRole);
		row('changes', 'Show their recent changes', 'history', a.recentChanges);
		row('remove', 'Remove from session…', 'x', a.remove, { danger: true, tooltip: 'They can ask to join again' });
		row('block', 'Remove and block…', 'lock', a.removeBlock, { danger: true, tooltip: 'Refused for the rest of this session — Allow back in this panel' });
	}

	if (f.isAgent) {
		items.push({ section: 'AI agent' });
		// 56 C5/C6: Stop = cancel what it is answering now; Mute = the host/an admin stops delivery
		row('agent-stop', 'Stop request', 'circle-x', a.agentStop, a.agentStop ? { tooltip: 'Stop what it is answering — later steps return cancelled' } : off(f.agentBusy ? 'Only the person who asked, the host or an editor can stop it' : 'It is not answering anything right now'));
		row('agent-mute', f.agentMuted ? 'Unmute agent' : 'Mute agent', f.agentMuted ? 'mic' : 'mic-off', a.agentMute, a.agentMute ? { tooltip: f.agentMuted ? 'Deliver messages to it again' : 'Messages are no longer delivered to it — it stays in the session' } : off('Only the session host or an admin can mute an agent'));
		if (f.inviteId && f.canModerate) row('agent-revoke', 'Revoke invite', 'unlink', a.revokeInvite);
		// 67 P6: the tools it declared with a panel — the agent opens the panel for whoever asks (never a viewer)
		for (const t of (f.agentTools ?? []).filter((t) => t.panel)) {
			const open = a.openToolPanel;
			row('agent-tool-' + t.id, 'Open ' + t.name + ' panel', 'sliders-horizontal', open ? () => open(t.id) : undefined, f.viewerMe || !open ? off('Viewers cannot use agent panels') : { tooltip: 'The agent opens its ' + t.name + ' panel for you' });
		}
	}
	return items;
}
