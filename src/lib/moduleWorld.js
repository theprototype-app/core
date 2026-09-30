// 30b P5: MODULE CONTENT FOLLOWS THE WORLD — a leaf (svelte/store + sceneStore +
// moduleContent's registry).
//
// THE FINDING (the Quest report: "When I spin the world around, the untangled dots do not
// spin around"). The VR world gestures (71: two-grip scale/rotate/pan) transform the
// `world-grab-rig` group, and only what lives INSIDE it moves: objectsGroup, the grid, the
// notes, the particles. A module's viewport content — the Untangle board, the dungeon, the
// piano — lives at the SCENE ROOT (golden rule 5: never in objectsGroup, or it would enter
// GLTF sync), so it stayed pinned to the room while the rest of the world spun away.
//
// THE FIX, for every module at once: a `module-world-root` group INSIDE the rig (a sibling
// of objectsGroup, so golden rule 5 still holds — nothing here is serialised or sent), and
// every REGISTERED module group (registerInteractiveGroup / registerSystemGroup /
// registerListedGroup — the names the Module content list already knows) is re-homed
// under it the moment it reaches the scene root. Its LOCAL transform is untouched, so on
// the desktop (rig = identity) nothing moves at all, and in VR it rides the rig. A module
// converting world hits with `group.worldToLocal` (Untangle does) keeps working unchanged,
// because every matrix it reads is the true one.
//
// COMPATIBILITY, the two things a module can still do to "its scene-root group":
//  · `api.scene().remove(group)` — Object3D.remove only removes DIRECT children, so the
//    scene instance gets a remove that also takes a re-homed group back out;
//  · `scene.getObjectByName(name)` — a traversal, so it still finds it.
// Core's own scene-root scans (playSettings.playPublishers, moduleContent's rows) read
// `moduleWorldChildren()` as well as `scene.children`.
// Content a module adds WITHOUT registering a name cannot be told apart from the app's own
// scene-root helpers, so it stays where it was put.
import { get } from 'svelte/store';
import { globalScene } from '../stores/sceneStore';
import { moduleGroupList, moduleGroupsRevision, moduleContentRows } from './moduleContent';

export const MODULE_WORLD_ROOT = 'module-world-root';

/** @type {any} */ let root = null;
/** @type {any} */ let patchedScene = null;
let started = false;

/** the group inside the world rig that module content is re-homed under (null before mount) */
export function moduleWorldRoot() {
	return root;
}

/** the re-homed module groups (for scene-root scans that used to read scene.children) */
export function moduleWorldChildren() {
	return root ? root.children : [];
}

/** is `object` a module group at the top of the module world (or the scene root)? @param {any} object @param {any} scene */
export function isModuleTopLevel(object, scene) {
	return !!object && (object.parent === scene || (!!root && object.parent === root));
}

/** @param {any} object */
function registeredName(object) {
	if (!object?.name) return false;
	return moduleGroupList().some((entry) => entry.name === object.name);
}

/** move every registered module group sitting at the scene root under the module root */
export function adoptModuleGroups() {
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene || !root) return 0;
	let moved = 0;
	for (const child of [...scene.children]) {
		if (child === root || !registeredName(child)) continue;
		// .add re-parents (three removes it from the scene first) and KEEPS the local
		// transform — which is the point: the group's numbers become rig-relative
		root.add(child);
		moved++;
	}
	return moved;
}

/** give the scene a remove() that also finds a re-homed module group @param {any} scene */
function patchRemove(scene) {
	if (!scene || patchedScene === scene) return;
	patchedScene = scene;
	const nativeRemove = scene.remove;
	/** @param {...any} objects */
	scene.remove = function (...objects) {
		for (const object of objects) {
			if (root && object?.parent === root) root.remove(object);
			else nativeRemove.call(this, object);
		}
		return this;
	};
	// a registered group arriving later is re-homed as it lands (after the add returns —
	// never re-parent inside three's own add loop)
	scene.addEventListener?.('childadded', (/** @type {any} */ event) => {
		if (!registeredName(event.child)) return;
		queueMicrotask(adoptModuleGroups);
	});
}

/** Scene mounts the root inside the world rig. @param {any} group */
export function setModuleWorldRoot(group) {
	root = group;
	if (root) root.name = MODULE_WORLD_ROOT;
	start();
	adoptModuleGroups();
}

function start() {
	if (started || typeof window === 'undefined') return;
	started = true;
	globalScene.subscribe((scene) => {
		patchRemove(scene);
		adoptModuleGroups();
	});
	// a name registered AFTER its group was added (register order varies by module)
	moduleGroupsRevision.subscribe(() => adoptModuleGroups());
}

/** test/debug view: what is re-homed, and what the object list's Module content lists */
export function moduleWorldDebug() {
	const scene = /** @type {any} */ (get(globalScene));
	return {
		root: !!root,
		rehomed: moduleWorldChildren().map((/** @type {any} */ c) => c.name),
		rows: moduleContentRows(scene).map((/** @type {any} */ row) => row.name)
	};
}
