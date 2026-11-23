// 92-correct row 2 — the SMALL half of copyGraphs.js, loaded with the app: the instance id rule and the
// registry of copies that are not scene objects (kit entities). The instancing itself (copyGraphs.js) is
// loaded only once a scene holds a spawned copy, so a scene with none pays nothing for it at boot.
// Imports nothing (unit-tested).

export const INSTANCE_SEP = '~';

/** @param {string} owner @param {string} id */
export function instanceId(owner, id) {
	return owner + INSTANCE_SEP + id;
}

/** the template node id an instance id stands for (an ordinary id answers itself) @param {string} id */
export function instanceBaseId(id) {
	if (typeof id !== 'string') return id;
	const i = id.indexOf(INSTANCE_SEP);
	return i > 0 ? id.slice(i + 1) : id;
}

/** the copy an instance id belongs to, or null @param {string} id */
export function instanceOwnerOf(id) {
	if (typeof id !== 'string') return null;
	const i = id.indexOf(INSTANCE_SEP);
	return i > 0 ? id.slice(0, i) : null;
}

/** the key that changes exactly when the set of instances would @param {{uuid: string, from: string}[]} copies @param {Set<string>} graphs */
export function instanceKey(copies, graphs) {
	return copies
		.filter((c) => graphs.has(c.from))
		.map((c) => c.uuid + '>' + c.from)
		.sort()
		.join(',');
}

// ---- copies that are not scene objects (kit entities) ------------------------------------------
// A kit entity is drawn as a LOCAL copy of its template (kit/entityApp.js): no uuid every peer shares,
// no `duplicate`. Its shared name is the entity id, so the kit registers id -> template here and the
// runtime instances the template's event part under that id; a kit action in it fills its object
// input with the id (kit/nodes.js withOwner), so "this object" is the entity.

/** owner id -> template uuid @type {Map<string, string>} */
const extraCopies = new Map();
/** @type {Set<() => void>} */
const listeners = new Set();
let notifyQueued = false;
function notify() {
	if (notifyQueued) return;
	notifyQueued = true;
	queueMicrotask(() => {
		notifyQueued = false;
		for (const fn of listeners) fn();
	});
}

/** @param {string} id @param {string} from */
export function registerCopy(id, from) {
	if (!id || !from || extraCopies.get(id) === from) return;
	extraCopies.set(id, from);
	notify();
}
/** @param {string} id */
export function unregisterCopy(id) {
	if (extraCopies.delete(id)) notify();
}
/** @returns {{uuid: string, from: string}[]} */
export function extraCopyList() {
	return [...extraCopies].map(([uuid, from]) => ({ uuid, from }));
}
/** the template of a registered copy, or null @param {string} id */
export function extraCopyFrom(id) {
	return extraCopies.get(id) ?? null;
}
/** @param {() => void} fn @returns {() => void} */
export function onCopiesChanged(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
