import { writable, get } from 'svelte/store';

// Window tab groups (phase 83, floating windows only — docked splits stay in
// pending/81). Grouped windows share ONE rect; the active member is visible,
// the rest are display:none, and TabStrips.svelte draws a notebook tab strip
// over the header area. Members register through the `tabbable` action with
// their open-store, so closing a window through its normal path just removes
// its tab.

/** @type {Map<string, {node: any, title: string, close?: () => void, unsub?: () => void}>} */
const registry = new Map();

/** [{id, members: string[], active: string, rect: {left, top, width, height}}] */
export const tabGroups = writable(/** @type {any[]} */ ([]));

let nextId = 1;

function persist() {
	try {
		localStorage.setItem(
			'windowTabGroups',
			JSON.stringify(get(tabGroups).map(({ id, members, active, rect }) => ({ id, members, active, rect })))
		);
	} catch {}
}

/** @type {any[]} groups waiting for their members to register+open again */
let pendingRestore = [];
try {
	pendingRestore = JSON.parse(localStorage.getItem('windowTabGroups') ?? '[]');
} catch {}

/** @param {any} node */
function rectOf(node) {
	const r = node.getBoundingClientRect();
	return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** @param {any} node @param {any} rect @param {boolean} visible */
function applyMember(node, rect, visible) {
	node.style.left = rect.left + 'px';
	node.style.top = rect.top + 'px';
	node.style.right = 'auto';
	node.style.width = rect.width + 'px';
	node.style.height = rect.height + 'px';
	node.style.display = visible ? '' : 'none';
}

function applyGroups() {
	for (const group of get(tabGroups)) {
		for (const key of group.members) {
			const entry = registry.get(key);
			if (entry) applyMember(entry.node, group.rect, key === group.active);
		}
	}
	persist();
}

/** The tab group a window belongs to, or null. @param {string} key */
export function groupOfKey(key) {
	return get(tabGroups).find((group) => group.members.includes(key)) ?? null;
}

/** @param {string} key drop target @param {string} addKey dragged window */
export function mergeWindows(key, addKey) {
	if (key === addKey) return;
	const target = registry.get(key);
	const added = registry.get(addKey);
	if (!target || !added) return;
	removeFromGroup(addKey, false);
	let group = groupOfKey(key);
	if (!group) {
		group = { id: 'tg' + nextId++, members: [key], active: key, rect: rectOf(target.node) };
		tabGroups.update((groups) => [...groups, group]);
	}
	tabGroups.update((groups) =>
		groups.map((entry) =>
			entry.id === group.id
				? { ...entry, members: [...entry.members, addKey], active: addKey }
				: entry
		)
	);
	applyGroups();
}

/** @param {string} key @param {boolean=} restoreDisplay */
export function removeFromGroup(key, restoreDisplay = true) {
	const group = groupOfKey(key);
	if (!group) return;
	const entry = registry.get(key);
	if (entry && restoreDisplay) entry.node.style.display = '';
	tabGroups.update((groups) =>
		groups
			.map((g) => {
				if (g.id !== group.id) return g;
				const members = g.members.filter((m) => m !== key);
				return { ...g, members, active: g.active === key ? members[0] : g.active };
			})
			// a group of one dissolves — the last member gets its header back
			.filter((g) => {
				if (g.members.length >= 2) return true;
				const last = registry.get(g.members[0]);
				if (last) last.node.style.display = '';
				return false;
			})
	);
	applyGroups();
}

/** @param {string} groupId @param {string} key */
export function activateTab(groupId, key) {
	tabGroups.update((groups) =>
		groups.map((group) => {
			if (group.id !== groupId) return group;
			// adopt any resize the active member did before switching
			const current = registry.get(group.active);
			const rect = current && current.node.style.display !== 'none' ? rectOf(current.node) : group.rect;
			return { ...group, rect, active: key };
		})
	);
	applyGroups();
}

/** Resize the whole group a window belongs to — every member shares ONE size, so
 * dragging any member's grip resizes them all (not just the active tab). Returns
 * false when the window isn't grouped, so the caller keeps its own local resize.
 * @param {string} key @param {number} width @param {number} height */
export function resizeGroup(key, width, height) {
	const group = groupOfKey(key);
	if (!group) return false;
	tabGroups.update((groups) =>
		groups.map((g) => (g.id === group.id ? { ...g, rect: { ...g.rect, width, height } } : g))
	);
	applyGroups();
	return true;
}

/** The group rect a window belongs to, or null if it isn't grouped. @param {string} key */
export function groupRectOf(key) {
	return groupOfKey(key)?.rect ?? null;
}

/** Move the whole group a window belongs to by (dx,dy). @param {string} key @param {number} dx @param {number} dy */
export function moveGroupOf(key, dx, dy) {
	const group = groupOfKey(key);
	if (group) moveGroup(group.id, dx, dy);
	return !!group;
}

/** @param {string} groupId @param {number} dx @param {number} dy */
export function moveGroup(groupId, dx, dy) {
	tabGroups.update((groups) =>
		groups.map((group) =>
			group.id === groupId
				? { ...group, rect: { ...group.rect, left: group.rect.left + dx, top: group.rect.top + dy } }
				: group
		)
	);
	applyGroups();
}

/** Tear a tab out to a screen position @param {string} key @param {number} x @param {number} y */
export function tearOff(key, x, y) {
	const entry = registry.get(key);
	removeFromGroup(key);
	if (entry) {
		entry.node.style.left = Math.max(0, x - 100) + 'px';
		entry.node.style.top = Math.max(0, y - 12) + 'px';
		entry.node.style.display = '';
	}
}

/** @param {string} key */
export function titleOf(key) {
	return registry.get(key)?.title ?? key;
}

/** @param {string} key */
export function nodeOf(key) {
	return registry.get(key)?.node ?? null;
}

/** @param {string} key */
export function closeMember(key) {
	registry.get(key)?.close?.();
}

/** Close EVERY member of the group the key belongs to (128: the tab ✕ closes
 * the whole tab group, not just the active tab). @param {string} key */
export function closeGroup(key) {
	const group = groupOfKey(key);
	const members = group ? [...group.members] : [key];
	for (const member of members) registry.get(member)?.close?.();
}

function tryRestore() {
	pendingRestore = pendingRestore.filter((saved) => {
		const ready = saved.members.every((m) => registry.has(m));
		if (!ready) return true;
		tabGroups.update((groups) => [
			...groups,
			{ ...saved, id: 'tg' + nextId++, active: saved.members.includes(saved.active) ? saved.active : saved.members[0] }
		]);
		applyGroups();
		return false;
	});
}

/**
 * svelte action for a floating window that can join tab groups.
 * @param {any} node
 * @param {{key: string, title: string, openStore?: any, isOpen?: (v: any) => boolean, close?: () => void}} options
 */
export function tabbable(node, { key, title, openStore, isOpen = (v) => !!v, close }) {
	registry.set(key, { node, title, close });

	// closing through the window's own path removes the tab
	let first = true;
	const unsub = openStore?.subscribe((/** @type {any} */ value) => {
		if (first) {
			first = false;
			return;
		}
		if (!isOpen(value)) removeFromGroup(key, false);
		// reopening must clear the inline display:none a tab group left behind —
		// otherwise a window closed while it was an INACTIVE member never comes
		// back (its class toggles but the inline style still hides it) (92)
		else node.style.display = '';
	});

	// drag-merge: dropping this window's header onto another window's header
	let draggingHeader = false;
	/** @type {any} */ let mergeTarget = null;
	/** the window whose HEADER is under (x, y) — the merge hit test */
	const targetAt = (/** @type {number} */ x, /** @type {number} */ y) => {
		for (const [otherKey, other] of registry) {
			if (otherKey === key) continue;
			if (other.node.dataset?.docked) continue; // docked windows don't tab (81L)
			if (!other.node.isConnected || other.node.style.display === 'none') continue;
			if (other.node.offsetParent === null && getComputedStyle(other.node).position !== 'fixed') continue;
			const r = other.node.getBoundingClientRect();
			if (r.width === 0) continue;
			if (x >= r.left && x <= r.right && y >= r.top && y <= r.top + 36) return otherKey;
		}
		return null;
	};
	const setMergeTarget = (/** @type {string | null} */ otherKey) => {
		const next = otherKey ? registry.get(otherKey)?.node : null;
		if (next === mergeTarget) return;
		mergeTarget?.classList.remove('merge-target');
		mergeTarget = next ?? null;
		mergeTarget?.classList.add('merge-target');
	};
	const down = (/** @type {any} */ e) => {
		if (!e.target.closest('.move-handle')) return;
		if (groupOfKey(key)) return; // grouped windows drag via the strip
		draggingHeader = true;
	};
	const move = (/** @type {any} */ e) => {
		// live feedback (104): the header you would merge into lights up
		if (draggingHeader) setMergeTarget(targetAt(e.clientX, e.clientY));
	};
	const up = (/** @type {any} */ e) => {
		if (!draggingHeader) return;
		draggingHeader = false;
		setMergeTarget(null);
		const otherKey = targetAt(e.clientX, e.clientY);
		if (otherKey) mergeWindows(otherKey, key);
	};
	node.addEventListener('pointerdown', down);
	window.addEventListener('pointermove', move);
	window.addEventListener('pointerup', up);

	tryRestore();

	return {
		destroy() {
			node.removeEventListener('pointerdown', down);
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			setMergeTarget(null);
			unsub?.();
			removeFromGroup(key, false);
			registry.delete(key);
		}
	};
}
