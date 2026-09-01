import { writable, get } from 'svelte/store';

// Window tab groups (phase 83, floating windows only — docked splits stay in
// pending/81). Grouped windows share ONE rect; the active member is visible,
// the rest are display:none, and TabStrips.svelte draws a notebook tab strip
// over the header area. Members register through the `tabbable` action with
// their open-store, so closing a window through its normal path just removes
// its tab.

/** `minW`/`minH` are what a member needs to render — see `groupFloor`; absent means the
 * shared default is enough.
 * @type {Map<string, {node: any, title: string, close?: () => void, unsub?: () => void, minW?: number, minH?: number}>} */
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

/**
 * Keys this store has RENAMED, applied to every restored group. Flow Code registered
 * as 'flowCode' while every module that addresses windowTabs from the outside
 * (`panelToggles`, `bottomDockable`, `headerTargetAt`) passes the DOCK key 'flowcode',
 * so the two never met; aligning them without this map would strand any group already
 * saved under the old spelling — `tryRestore` waits for a member that can no longer
 * register, so the group would sit in `pendingRestore` for ever and the user's Flow
 * Code tab would simply never come back.
 * @type {Record<string, string>}
 */
const KEY_ALIASES = { flowCode: 'flowcode' };
/** @param {string} key */
const migrateKey = (key) => KEY_ALIASES[key] ?? key;

/** @type {any[]} groups waiting for their members to register+open again */
let pendingRestore = [];
try {
	pendingRestore = JSON.parse(localStorage.getItem('windowTabGroups') ?? '[]').map(
		(/** @type {any} */ saved) => ({
			...saved,
			members: (saved.members ?? []).map(migrateKey),
			active: migrateKey(saved.active)
		})
	);
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
	/**
	 * R22 ROUND 29 — WHO OWNS THIS WINDOW'S GEOMETRY, stated on the node itself.
	 *
	 * A grouped window is positioned by its GROUP, not by its own dragWindow rect, and
	 * dragWindow has a rule that fights that: on a hidden -> visible transition it re-clamps
	 * the window fully on-screen from ITS OWN stored position. A tab switch is exactly that
	 * transition, so the member being revealed jumped back to wherever it last floated while
	 * the tab strip stayed on the group rect — the strip visibly detached from the window,
	 * and the group rect then re-derived from the misplaced member, so switching BACK was
	 * wrong too. Measured on the user's repro: group at (160,120), Explorer at (160,120),
	 * node editor at (120,90), its own defaultRect.
	 *
	 * A DATA ATTRIBUTE rather than an import: dragWindow already owns this node and reads
	 * its own DOM, so a flag on the element says "someone else places this" without either
	 * module learning about the other. windowTabs is the only writer, and it clears the flag
	 * on every path a window leaves a group by.
	 */
	node.dataset.tabMember = '1';
}

/** A window is placing itself again — see `applyMember`. @param {any} node */
function releaseMember(node) {
	if (node?.dataset) delete node.dataset.tabMember;
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
/** Re-apply the floor — called after the membership changes, since a group that gains a
 * tab can find itself narrower than its own strip. @param {string} groupId */
function enforceFloor(groupId) {
	tabGroups.update((groups) =>
		groups.map((g) => {
			if (g.id !== groupId) return g;
			const floor = groupFloor(g);
			if (g.rect.width >= floor.w && g.rect.height >= floor.h) return g;
			return {
				...g,
				rect: { ...g.rect, width: Math.max(floor.w, g.rect.width), height: Math.max(floor.h, g.rect.height) }
			};
		})
	);
}

/** Fold the addKey window into the key window's group, creating the group if needed.
 * @param {string} key @param {string} addKey */
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
	// a group that GAINS a tab can find itself narrower than its own strip
	enforceFloor(group.id);
	applyGroups();
}

/** @param {string} key @param {boolean=} restoreDisplay */
export function removeFromGroup(key, restoreDisplay = true) {
	const group = groupOfKey(key);
	if (!group) return;
	const entry = registry.get(key);
	if (entry) releaseMember(entry.node); // it places itself again from here
	if (entry && restoreDisplay) entry.node.style.display = '';
	tabGroups.update((groups) =>
		groups
			.map((g) => {
				if (g.id !== group.id) return g;
				const members = g.members.filter((/** @type {string} */ m) => m !== key);
				return { ...g, members, active: g.active === key ? members[0] : g.active };
			})
			// a group of one dissolves — the last member gets its header back
			.filter((g) => {
				if (g.members.length >= 2) return true;
				const last = registry.get(g.members[0]);
				if (last) releaseMember(last.node); // the last one out is a lone window again
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
/**
 * R22 ROUND 26 (user): "for grouped window ... I should not be able to make it smaller than
 * smallest of one of them, so when I switch there are no break of header/window, and should
 * not be possible to make smaller in width than amount of tabs in tabbed window".
 *
 * A GROUP IS ONE BOX SHOWING ONE MEMBER AT A TIME, and that is what makes its floor
 * different from a lone window's. A size that suits the member on screen can break the one
 * behind it — and you do not find out until you switch tabs, by which point you have
 * forgotten what you resized. So the floor is the WORST CASE across the members, not the
 * one you happen to be looking at.
 *
 * The second half is the tab strip itself: a group narrower than its own tabs cannot show
 * you what is in it, which is the one thing a group exists for. `TAB_MIN` is deliberately
 * generous per tab — a tab holds a title, and one clipped to three characters is not a
 * label. It is a FLOOR, not a layout: the strip still truncates long titles at any width.
 *
 * clampWinSize is not reused here on purpose. It answers "does this fit ON SCREEN",
 * which a group needs too, but its minimum is a single constant — the question here is
 * what these particular members need, which only the group knows.
 */
const GROUP_MIN_W = 260;
const GROUP_MIN_H = 180;
const TAB_MIN = 96;

/**
 * The smallest this group may be.
 *
 * R22 ROUND 28 — THE FLOOR IS THE WORST CASE ACROSS THE MEMBERS, which is what the user
 * asked for in the first place ("not smaller than smallest of one of them") and what round
 * 26 only half-delivered: it used a flat constant, so a group of two could be driven to
 * 260px whatever was in it. Reproduced from the user's own steps — undock the Explorer,
 * undock the node editor, stack them, shrink to the floor — and the node editor at 260px
 * is visibly wrecked: its panels overlap, its own header peeks out above the strip, and
 * the canvas has nowhere to be. The Explorer survives the same width only because round 25
 * taught its header to shed things.
 *
 * So a member DECLARES what it needs through `tabbable`, and the group takes the maximum.
 * A window that declares nothing keeps the old constant, which is what every simple panel
 * wants; the ones that need more are the ones with furniture inside them.
 *
 * Three inputs, all of which have to hold at once: what the widest member needs, what the
 * tab strip needs to show its own tabs, and the floor below which no window is usable.
 * @param {any} group
 */
export function groupFloor(group) {
	const members = group?.members ?? [];
	const tabs = members.length || 1;
	let needW = GROUP_MIN_W;
	let needH = GROUP_MIN_H;
	for (const key of members) {
		const entry = registry.get(key);
		if (entry?.minW) needW = Math.max(needW, entry.minW);
		if (entry?.minH) needH = Math.max(needH, entry.minH);
	}
	// the strip also carries its own padding and the close button on the right
	return { w: Math.max(needW, tabs * TAB_MIN + 56), h: needH };
}

/** @param {string} key @param {number} width @param {number} height */
export function resizeGroup(key, width, height) {
	const group = groupOfKey(key);
	if (!group) return false;
	const floor = groupFloor(group);
	const w = Math.max(floor.w, width || 0);
	const h = Math.max(floor.h, height || 0);
	tabGroups.update((groups) =>
		groups.map((g) => (g.id === group.id ? { ...g, rect: { ...g.rect, width: w, height: h } } : g))
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
		releaseMember(entry.node); // torn off: its own position from now on
		entry.node.style.left = Math.max(0, x - 100) + 'px';
		entry.node.style.top = Math.max(0, y - 12) + 'px';
		entry.node.style.display = '';
	}
}

/**
 * The window whose HEADER is under (x, y) — the merge hit test, lifted out of
 * `tabbable`'s closure in W7 so it can be ONE test rather than one per window. It is
 * also the top of the drop PRECEDENCE order: a header is a small, deliberate target, so
 * the bottom-dock band stands down wherever this answers (see bottomDockDrop.js).
 * @param {number} x @param {number} y @param {string=} excludeKey the window being dragged
 * @returns {string|null}
 */
export function headerTargetAt(x, y, excludeKey) {
	for (const [otherKey, other] of registry) {
		if (otherKey === excludeKey) continue;
		if (other.node.dataset?.docked) continue; // docked windows don't tab (81L)
		if (!other.node.isConnected || other.node.style.display === 'none') continue;
		if (other.node.offsetParent === null && getComputedStyle(other.node).position !== 'fixed') continue;
		const r = other.node.getBoundingClientRect();
		if (r.width === 0) continue;
		if (x >= r.left && x <= r.right && y >= r.top && y <= r.top + 36) return otherKey;
	}
	return null;
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
		const ready = saved.members.every((/** @type {string} */ m) => registry.has(m));
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
 * @param {{key: string, title: string, openStore?: any, isOpen?: (v: any) => boolean, close?: () => void, minW?: number, minH?: number}} options
 */
export function tabbable(node, { key, title, openStore, isOpen = (v) => !!v, close, minW, minH }) {
	registry.set(key, { node, title, close, minW, minH });

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
	/** the window whose HEADER is under (x, y) — the merge hit test (W7 lifted the body
	 * to module scope so the bottom-dock band can consult the very same rule) */
	const targetAt = (/** @type {number} */ x, /** @type {number} */ y) => headerTargetAt(x, y, key);
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
