import * as THREE from 'three';
import { globalScene, objectsGroup, showGrid, TControls, lockedObjects, selectedObject, globalCamera, peerHands, pokeScene, beginSceneBatch, endSceneBatch } from '../stores/sceneStore.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGeometry, createLight, createGroup } from '$lib/geometries.svelte'
import { applyMap, switchMaterialType, setMaterialParam, applyMaterials, isMultiMaterial, serializeMeshWithGroups } from '$lib/materialsHandler'
import { recordObjectPresence } from '$lib/history'
import { voicePeerDisconnected } from '$lib/voiceChat'
import { physicsPeerDisconnected, physicsShapeChanged } from '$lib/physics'
import { dropPeerCursor } from '$lib/nodesHandler'
import { dropPeerQuality } from '$lib/networkQuality'
import { dropPeerClock } from '$lib/musicClock'
import { applyRemoteDevice } from '$lib/audioDevices'
import { sessionHost, dropPeerJoined } from '$lib/connectionState'
import { environment } from '$lib/environment'
import { hasAnimatedImport, sendAnimatedImport, setAnimationState, dropAllAnimatedImports } from '$lib/animatedImports'
import { dropAllAnimations } from '$lib/animationPreview'
import { parkAnimatedAtBase } from '$lib/flowRuntime'
import { stripEditOverlays } from '$lib/editOverlays'
import { runSceneClearHandlers } from '$lib/moduleSDK'
import { annotations } from '$lib/annotationsHandler'
import { isViewer, warnViewerReadOnly } from '$lib/objectPermissions'
import { get, writable } from 'svelte/store'
import { addMessage, loading, loadingcount, showToast, fixLight, specatorMode } from '../stores/appStore';
import { dropWireErrors } from './wireErrors';
import { peers, userdata } from '../stores/appStore';
// 27-G (audit H6): removing an object frees NOTHING on the GPU. These free what only
// the departing object was using, and never what the rest of the scene still holds.
import { disposeTree, keepSet } from '$lib/disposeTree';
import { safeStorage } from './safeStorage';
// 26-A: the backlog is a reading the Statistics panel wants and sceneBudget cannot
// reach — it REGISTERS rather than importing us, the registerDiagnosticsSection shape.
import { registerMetricSource, ingestVerdict, profileFor } from './sceneBudget';
import { globalRenderer } from '../stores/sceneStore.js';

//Access scene Store
let scene = $state();
globalScene.subscribe(value => { scene = value });

//Access objects Store
let sceneObjects = $state();
objectsGroup.subscribe(value => { sceneObjects = value });

//Access peers Store
let peer = $state();
peers.subscribe(value => { peer = value });

//Access object controls
let controls = $state();
TControls.subscribe(value => { controls = value });

//Access locked objects
let locked = $state();
lockedObjects.subscribe(value => { locked = value });

//Access selected object
let selected = $state();
selectedObject.subscribe(value => { selected = value });

//Access userdata
let users = $state();
userdata.subscribe(value => { users = value });

//Access specatorMode
let specating = $state();
specatorMode.subscribe(value => { specating = value });

//Access globalCamera
let camera = $state();
globalCamera.subscribe(value => { camera = value });

const loader = new THREE.ObjectLoader();


export function userData(data) {
    // 27-A (audit H1): the roster applier called .forEach on whatever arrived. A malformed
    // `userdata` threw out of the dispatcher, which had no try/catch — the A1 note below
    // records the same class of failure in `specator`.
    if (!Array.isArray(data)) return;
    data.forEach(element => {
        if (!Array.isArray(element) || typeof element[0] !== 'string') return;
        console.log('received new approved host : ' + element[0])
        if (!users.some(u => u[0] === element[0]))
            users.push(element)
        else
        {
            let index = users.findIndex(u => u[0] === element[0]);
            if (element[1] != '') users[index][1] = element[1];
            if (element[2] != '') users[index][2] = element[2];
            // avatar config (slot 5) from newer clients
            if (element[5]) users[index][5] = element[5];
        }

    })
    userdata.set(users);

    //Trigger reactivity for UI list of objects
    userdata.update((value) => value);
}

// A1 crash guards. Both halves of this used to assume the peer is in OUR roster and
// has an avatar mesh in OUR scene, and neither is a safe assumption: `findIndex`
// answers -1 for a peer we have no row for, and `users[-1][3]` throws out of the
// message dispatcher, which has no try/catch — so one stray message takes the whole
// connection handler down. Load-bearing the moment room gating hides a peer standing
// in another scene: their avatar is legitimately not in the scene, and their watch
// message must land harmlessly rather than crash the page.
export function specator(data, specator) {
    if ( specator === 'false') {
        let index = users.findIndex(u => u[0] === data.peerId);
        if (index < 0) return;
        users[index][3] = null;
        return;
    }
    // park the avatar out of shot only if there IS one
    const avatar = scene?.getObjectByName(data.peerId);
    if (avatar) avatar.position.set(0, 1000, 0);
    let index = users.findIndex(u => u[0] === data.peerId);
    if (index < 0) return;
    users[index][3] = specator;
}

export function cameraSettings(data) {
    // console.log('peer sent camera settings: ' + data.fov);
    if ( data.fov ) {
        let index = users.findIndex(u => u[0] === data.peerId);
        // the same guard, same reason: a peer with no roster row here is not one we
        // can be watching either, so there is nothing to record and nothing to apply
        if (index < 0) return;
        users[index][4] = data.fov;
        //update camera fov if watching peer camera
        if (specating === data.peerId)
        {
            camera.fov = data.fov;
            camera.updateProjectionMatrix();
        }
    }

}

export function sceneCommand(command) {
    if (command.startsWith('/')) {
        console.log('Executing command: ' + command);
        if (command.startsWith('/clear')) {
            if (command.split(' ')[1] == 'all')
            {
                // 15-J: viewer send-gate — peers drop a viewer's clearscene (cloud
                // capability gate), so clearing locally would only desync this client.
                if (isViewer()) { warnViewerReadOnly('View-only — ask an editor to clear the scene.'); return; }
                clearSceneLocal();
                peer.send({type: 'clearscene', peerId: peer.peer.id});
            } else {
                let object = sceneObjects.getObjectByProperty('uuid', command.split(' ')[1])
                if (object != null) {
                    // the undo entry is a toJSON SNAPSHOT (history.captureObjectSnapshot),
                    // not a live reference, so freeing the buffers here cannot strand it
                    recordObjectPresence('delete', object);
                    const keep = keepSet(sceneRoot(), object);
                    // parent-aware so nested objects are removed too
                    (object.parent ?? sceneObjects).remove(object);
                    disposeTree(object, { keep });
                }
                peer.send({type: 'delete', uuid: command.split(' ')[1], peerId: peer.peer.id});
            }
        }
        else if (command.startsWith('/grid')) {
            if (command.split(' ')[1] == 'on')
            {
                showGrid.set(true);
                safeStorage.removeItem('showGrid')
            }
            else if (command.split(' ')[1] == 'off')
            {
                showGrid.set(false);
                safeStorage.setItem('showGrid', false);
            }
        }
        else if (command.startsWith('/create')) {
                let uuid = createGeometry(command);
                console.log(uuid + ' created');
                if(uuid != null) {
                peer.send({type: 'create', command: command, uuid: uuid});
                recordObjectPresence('create', sceneObjects.getObjectByProperty('uuid', uuid));
                }
                peer.send({type: 'lock', uuid: uuid, peerId: peer.peer.id});

                // the environment rig lights every preset except Classic —
                // only nag about missing lights in Classic
                if (get(environment).preset === 'classic') {
                    fixLight.set(true);
                    sceneObjects.traverse((object) => {
                        if (object.isLight) {
                            fixLight.set(false);
                        }
                        });
                }
        }
        else if (command.startsWith('/light')) {
                let uuid = createLight(command);
                console.log(uuid + ' created');
                if(uuid != null) {
                peer.send({type: 'light', command: command, uuid: uuid});
                recordObjectPresence('create', sceneObjects.getObjectByProperty('uuid', uuid));
                }
                peer.send({type: 'lock', uuid: uuid, peerId: peer.peer.id});
        }
        else if (command.startsWith('/group')) {
                let uuid = createGroup(command);
                console.log(uuid + ' created');
                if(uuid != null) {
                peer.send({type: 'group', command: command, uuid: uuid});
                recordObjectPresence('create', sceneObjects.getObjectByProperty('uuid', uuid));
                }
                peer.send({type: 'lock', uuid: uuid, peerId: peer.peer.id});
        }
        else if (command.startsWith('/transform')) {
            const regex = /(\translate|\.rotate|\.scale)/i;
		    if (!regex.test(command.split(' ')[1]))
            controls.setMode( command.split(' ')[1])
            else
            console.log('Invalid command: ' + command);
        }
        else if (command.startsWith('/select')) {
            let uuid = command.split(' ')[1]
            if(sceneObjects.getObjectByProperty( 'uuid' , uuid) != null) {
                console.log(locked.filter(lockedUuid => lockedUuid[1] === uuid));
                if(locked.length != 0){
                    console.log(locked)
                    if(!locked.filter(lockedUuid => lockedUuid[1] === uuid)) {
                        controls.attach(sceneObjects.getObjectByProperty( 'uuid' , uuid));
                        peer.send({type: 'lock', uuid: command.split(' ')[1], peerId: peer.peer.id});
                    } else {
                        console.log('Object ' + uuid + ' already locked by ' + locked.find(lockedUuid => lockedUuid[1] === uuid)[0]);
                    }
                } else {
                    controls.attach(sceneObjects.getObjectByProperty( 'uuid' , uuid));
                    peer.send({type: 'lock', uuid: command.split(' ')[1], peerId: peer.peer.id});
                }
            }
            else
            console.log('Object uuid not found: ' + command.split(' ')[1]);
        }
        else if (command.startsWith('/list')) {
            addMessage({message: "List of objects:", type: '', sender: 'SYSTEM'});
            sceneObjects.children.forEach((mesh, index) => {
                addMessage({message: 'name: \"' + mesh.name + '\" uuid: ' + mesh.uuid, type: 'info', sender: index})
            }
        );
        }
    }
    //Trigger reactivity for UI list of objects
    pokeScene();
}

/**
 * Full local scene wipe (both the local /clear all and the clearscene message):
 * objects, module viewport content, annotations, locks and byte registries.
 */
/** The scene ROOT for keep-set purposes. Scene-root helpers share resources with real
 * meshes on purpose (an onion-skin ghost shares its source mesh's geometry), so a keep
 * set computed over the replicated group alone would free things still being drawn. */
function sceneRoot() {
    return scene ?? sceneObjects;
}

export function clearSceneLocal() {
    controls?.detach();
    // 26-B: anything still parked in the ingest queue belongs to the scene being wiped
    dropIngestQueue();
    clearLoadingBatch();
    // 27-G: `clear()` drops the references and frees nothing, so a session that opens and
    // clears several scenes pays for every one of them until the context dies.
    const doomed = sceneObjects ? [...sceneObjects.children] : [];
    if (doomed.length) {
        const keep = keepSet(sceneRoot(), doomed);
        for (const child of doomed) disposeTree(child, { keep });
    }
    sceneObjects?.clear();
    runSceneClearHandlers(); // modules remove their scene-root content
    annotations.set([]);
    lockedObjects.set([]);
    // animated-import bytes/mixers are per-object — all gone now
    dropAllAnimatedImports();
    // authored clips were the one registry a wipe used to leak (dropAnimation had
    // no call site at all before 17-E)
    dropAllAnimations();
    pokeScene();
}

/** A peer wiped the shared scene @param {string} peerId */
export function applyClearScene(peerId) {
    clearSceneLocal();
    showToast(peerId + ' cleared the scene');
}

export function lockRestore(lockeditems) {
    // 27-A: same trust, same fix — a non-array here threw inside the handshake.
    if (!Array.isArray(lockeditems)) return;
    // Filter out the current peer id locks
    locked = locked.concat(lockeditems.filter((lock) => Array.isArray(lock) && lock[0] != peer.peer.id));
    // Update the locked objects store
    lockedObjects.set(locked);
}

export function handleDisconnected(peerId) {
    console.log(peerId + ' disconnected');
    // Full per-peer teardown, idempotent so it's safe to run from both the
    // conn-close path AND a relayed 'disconnected' message. Toast only while the
    // peer is still known, so relayed duplicates don't stack toasts (172).
    delete rosterFirstSeen[peerId];
    const known = users.some((/** @type {any} */ u) => u[0] === peerId);
    if (known) showToast(peerId + ' disconnected');
    users = users.filter(u => u[0] !== peerId);
    userdata.set(users);
    userdata.update((value) => value);
    // release every remote lock this peer held, keyed by peer id (the checkLocks
    // uuid-based loop mis-handled this and could strand or wrongly drop locks)
    locked = locked.filter((/** @type {any} */ l) => l[0] !== peerId);
    lockedObjects.set(locked);
    // drop their VR hand markers
    peerHands.update((map) => {
        const next = { ...map };
        delete next[peerId];
        return next;
    });
    dropPeerCursor(peerId);
    dropPeerQuality(peerId); // N3: drop the peer's network-quality telemetry
    dropWireErrors(peerId); // 27-A: and its wire-failure counters (golden rule 3)
    dropPeerClock(peerId); // 23-A2: and their clock-offset samples
    // CN: host bookkeeping — the host leaving means we're no longer "joined"
    if (get(sessionHost) === peerId) sessionHost.set(null);
    dropPeerJoined(peerId);
    voicePeerDisconnected(peerId);
    physicsPeerDisconnected(peerId);
    // 26-B (audit M2): the objects they were sending are never coming. Clearing the
    // batch here is what stops "Receiving objects: 3/40" living forever on screen, and
    // it drops the parked queue so a half-sent scene does not trickle in afterwards.
    if (loadingSender === peerId) {
        const left = /** @type {string[]} */ (get(loading)).length;
        clearLoadingBatch();
        if (left) showToast('The scene transfer stopped — ' + peerId + ' left.');
    }
}

// Local age-out for roster entries that never grew a connection (a peer that
// vanished between the roster broadcast and our dial). First sighted -> pruned
// after ROSTER_GRACE_MS with no conn. LOCAL only, and long enough that mesh
// formation (roster runs ahead of the dials) never trips it.
const ROSTER_GRACE_MS = 30000;
/** @type {Record<string, number>} */
let rosterFirstSeen = {};

export function checkLocks(data) {

    // Roster reaper, 500ms after a connection closes anywhere. This used to
    // BROADCAST {type:'disconnected'} for every roster entry it had no conn to —
    // but "I never dialed X" is not "X is gone": during mesh formation the
    // roster (broadcast at approval) runs ahead of the dials, and the relay
    // evicted LIVE peers from every other peer in the session (B5). Witnessed
    // drops now relay from finalizeDisconnect after the reconnect window;
    // entries nobody ever reached just age out locally.
    setTimeout(() => {

    users.forEach((/** @type {any} */ user) => {
        const id = user[0];
        if (id === peer.peer.id) return; // ignore current peerId
        if (peer.openedPeers.has(id)) { delete rosterFirstSeen[id]; return; } // live
        if (peer.connections[id] || peer.reconnecting?.has(id)) return; // dial or heal in flight
        const seen = rosterFirstSeen[id] ?? (rosterFirstSeen[id] = Date.now());
        if (Date.now() - seen < ROSTER_GRACE_MS) return;
        delete rosterFirstSeen[id];
        console.log('pruning roster entry ' + id + ' - no connection ever materialized');
        users = users.filter((/** @type {any} */ u) => u[0] !== id);
        userdata.set(users);
        userdata.update((value) => value);
    });

        }, 500)


    // Release the locks of peers that are actually gone (B5).
    //
    // This used peerjs's RAW map, `peer.peer.connections[id]` — an ARRAY of every
    // connection ever made to that id — and treated `length <= 1` as "not
    // connected anymore". A healthy peer holds exactly ONE DataConnection, so that
    // matched every LIVE peer: any disconnect anywhere released every remote lock
    // in the session (seen in the N=5 stress run, where a survivor logged
    // "Peer <host> is not connected anymore. Releasing..." about the connected
    // host). `connections[id].open` is the liveness signal PeerConnection actually
    // maintains — the same test lockControl.startLockSweep already used.
    //
    // Rebuilt as ONE filter instead of a reassign-inside-forEach: the old loop
    // iterated a stale snapshot while `locked` was replaced under it, and matched
    // by UUID (dropping any peer's lock on that uuid) rather than by holder.
    const before = locked.length;
    locked = locked.filter((/** @type {any} */ objectLock) => {
        const holder = objectLock[0];
        if (holder === peer.peer.id) return true; // our own lock is ours to release
        const conn = peer.connections[holder];
        if (conn && conn.open) return true;
        // mid-blip: the holder's conn dropped but the reconnect window is still
        // running — their lock survives until finalizeDisconnect decides (B5)
        if (peer.reconnecting?.has(holder)) return true;
        console.log('Peer ' + holder + ' is not connected anymore. Releasing...' + objectLock[1]);
        return false;
    });
    if (locked.length !== before) lockedObjects.set(locked);
}

/** 26-B (audit M2): who announced the batch we are receiving, so their teardown can
 * clear it. LOCAL — nothing about this crosses the wire. */
/** @type {string | null} */
let loadingSender = null;
/** @type {any} */
let loadingStallTimer = null;
/** The progress bar sticks at "3/40" forever when the sender leaves mid-send or a parse
 * rejects. Nothing cleared it: the only writer was the Toasts effect, which removes a
 * uuid when its object APPEARS, and an object that never arrives never appears. */
const LOADING_STALL_MS = 60000;
let loadingStallMs = LOADING_STALL_MS;
/** TEST-ONLY: shorten the stall so "silence, not duration" is provable in seconds.
 * @param {number} [ms] omit to restore the real value */
export function setLoadingStallMsForTest(ms) {
    loadingStallMs = Number.isFinite(ms) && /** @type {number} */ (ms) > 0 ? /** @type {number} */ (ms) : LOADING_STALL_MS;
}

// 26-E: THE STALL IS SILENCE, NOT DURATION. The timer was armed once, at the announcement,
// and never again — so any transfer that simply took longer than a minute was declared
// dead while it was still arriving. The stress rig measured exactly that: a joiner
// receiving 3,000 boxes on a real GPU was still landing ~10 objects a second at 63s when
// the bar cleared and the toast said "1085 objects never arrived"; all 3,000 arrived by
// 180s. Every uuid that lands now re-arms it (the `loading` subscription below), so the
// 60s is measured from the LAST sign of life, which is what M2 meant by a stall.
function armLoadingStall() {
    clearTimeout(loadingStallTimer);
    loadingStallTimer = setTimeout(() => {
        const left = /** @type {string[]} */ (get(loading));
        if (!left.length) return;
        console.log('Receiving objects: giving up on ' + left.length + ' that never arrived');
        clearLoadingBatch();
        showToast(left.length + ' object' + (left.length === 1 ? '' : 's') + ' never arrived.');
    }, loadingStallMs);
}

// 26-E (roadmap 26 section 3, "handshake time-to-synced"): how long the last RECEIVED
// batch took, from its `loading` announcement to the last object landing. The receive
// side is where the cost is felt, and it is the one moment both ends of the interval
// are known locally — no clock is compared across peers. LOCAL, never sent.
/** @type {number} */
let loadingStartedAt = 0;
/** @type {number} */
let loadingAnnounced = 0;
/** uuids still outstanding when the batch was CLOSED rather than finished (a stall, a
 * departed sender, a cleared scene) — so a batch that never finished cannot report a
 * sync time as though it had. */
let loadingLeftAtClear = 0;
/** @type {{ms: number, objects: number, complete: boolean, at: number} | null} */
let lastSync = null;
/** The last batch that ENDED (finished or closed), or null before one has run. */
export function lastSyncStats() {
    return lastSync;
}
// Both ends of a batch pass through the store: the Toasts reconcile empties it as the
// last object appears, and `clearLoadingBatch` empties it on every other way out.
// Subscribing here sees both without touching either writer.
/** outstanding count at the last notification, so only PROGRESS re-arms the stall */
let loadingLastLeft = 0;
loading.subscribe((/** @type {any} */ left) => {
    const count = Array.isArray(left) ? left.length : 0;
    // progress on an open batch: re-arm — but only a timer that is running, never one the
    // ingest fork parked on purpose while its question is open
    if (loadingStartedAt && count > 0 && count < loadingLastLeft && loadingStallTimer) armLoadingStall();
    loadingLastLeft = count;
    if (!loadingStartedAt || count) return;
    lastSync = {
        ms: Math.round(performance.now() - loadingStartedAt),
        objects: loadingAnnounced,
        complete: loadingLeftAtClear === 0,
        at: Date.now()
    };
    loadingStartedAt = 0;
    loadingLeftAtClear = 0;
});
// only a batch that FINISHED has a sync time; a closed one says null rather than a
// number that would read as a fast join
registerMetricSource('syncMs', () => (lastSync?.complete ? lastSync.ms : null));
registerMetricSource('syncObjects', () => (lastSync?.complete ? lastSync.objects : null));

/** Close the batch: the bar goes away, the stall timer disarms. Idempotent. */
export function clearLoadingBatch() {
    if (loadingStartedAt) loadingLeftAtClear = /** @type {string[]} */ (get(loading)).length;
    clearTimeout(loadingStallTimer);
    loadingStallTimer = null;
    loadingSender = null;
    loading.set([]);
}

/** Count a uuid as ARRIVED even though no object exists for it — a parse that rejected,
 * or an object the sender dropped. Without this the bar waits out the full stall.
 * @param {string[] | string} uuids */
export function noteLoadFailed(uuids) {
    const gone = new Set(Array.isArray(uuids) ? uuids : [uuids]);
    const left = /** @type {string[]} */ (get(loading)).filter((u) => !gone.has(u));
    loading.set(left);
    if (!left.length) clearLoadingBatch();
}

/** @param {number} count @param {string[]} uuids @param {string} [senderId] */
export async function createLoader(count, uuids, senderId) {
    // console.log("create loader for " + count + " objects: " + uuids);
    loading.set(Array.isArray(uuids) ? uuids : []);
    loadingcount.set(count);
    loadingSender = senderId ?? null;
    // an empty announcement opens nothing to finish, so it starts no clock
    loadingStartedAt = Array.isArray(uuids) && uuids.length ? performance.now() : 0;
    loadingAnnounced = Number(count) || 0;
    // 26-C: THE ONE MOMENT the size is known and nothing has been applied. Past it a
    // 4,000-object scene is simply happening to you.
    const verdict = ingestVerdict(liveObjectCount(), count, profileFor(get(globalRenderer)));
    if (verdict.gate) {
        ingestHeld = true;
        ingestGate.set({
            count: verdict.incoming,
            allowed: verdict.allowed,
            total: verdict.total,
            limit: verdict.limit,
            sender: loadingSender
        });
        // the stall timer must NOT run while the question is open — the objects are
        // parked, not missing, and clearing the bar under an open fork would be a lie
        clearTimeout(loadingStallTimer);
        loadingStallTimer = null;
        return;
    }
    armLoadingStall();
}

export async function colorObject(uuid, color, near, far) {
    if (uuid == 'background') {
        scene.background = new THREE.Color(color);
    } else if (uuid == 'fog') {
        if (near != null && far != null)
        scene.fog = new THREE.Fog(color, near, far);
        else
        scene.fog = null;
    } else {
        let mesh = sceneObjects.getObjectByProperty('uuid', uuid);
        if (mesh) mesh.material.color.set(color);
    }
}

export async function objectParameters(data) {
    if (data.parameter == 'visible') {
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        if (mesh) mesh.visible = data.visible;
    } else if (data.parameter == 'material') {
        // carries over color/map/opacity from the previous material
        switchMaterialType(data.uuid, data.material, false);
    } else if (data.parameter == 'materials') {
        // UV4: the whole slot list + geometry groups. Both halves must arrive
        // together — an array material with no groups renders nothing.
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        if (mesh) applyMaterials(mesh, data.payload, false);
    } else if (data.parameter == 'map') {
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        // UV2: `slot` addresses one material of an ARRAY. Absent (an older peer,
        // or any single-material object) means slot 0 = today's behaviour.
        if (mesh) applyMap(mesh, data.map, data.slot ?? 0);
    } else if (data.parameter == 'materialParam') {
        setMaterialParam(data.uuid, data.key, data.value, false);
    } else if (data.parameter == 'animation') {
        setAnimationState(data.uuid, { clip: data.clip, playing: data.playing, speed: data.speed }, false);
    } else if (data.parameter == 'castShadow') {
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        if (mesh) mesh.castShadow = data.castShadow;
    } else if (data.parameter == 'receiveShadow') {
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        if (mesh) mesh.receiveShadow = data.receiveShadow;
    } else if (data.parameter == 'shading') {
        // M6: smooth/flat shading choice. Deterministic — the receiver derives
        // the normals from the SAME positions, so nothing but the flag travels.
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        if (mesh?.geometry) {
            mesh.userData.shading = data.shading;
            if (data.shading === 'smooth') {
                // DYNAMIC import: a static commandsHandler -> faceEdit edge would
                // be a new arc into the history.js cycle family (CLAUDE.md)
                const { smoothWeldedNormals } = await import('$lib/faceEdit');
                smoothWeldedNormals(mesh.geometry);
            } else mesh.geometry.computeVertexNormals();
            mesh.geometry.attributes.normal.needsUpdate = true;
            pokeScene();
        }
    } else if (data.parameter == 'physics') {
        // P-A: userData.physics is the source of truth for the Inspector-set
        // body params (mode/mass/restitution/friction/collider); null = cleared
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        if (mesh) {
            if (data.physics) mesh.userData.physics = data.physics;
            else delete mesh.userData.physics;
            pokeScene(); // collider viz re-syncs
            physicsShapeChanged(data.uuid); // CL-A A2: live mid-sim rebuild
        }
    } else if (data.parameter == 'origin') {
        // 17-D: userData.origin is the per-object transform ORIGIN — a local-space
        // pivot offset the tools transform around. null = the object's own zero.
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        if (mesh) {
            if (data.origin) mesh.userData.origin = data.origin;
            else delete mesh.userData.origin;
            pokeScene();
            physicsShapeChanged(data.uuid); // the body/collider pose follows the pivot
        }
    } else if (data.parameter == 'particles') {
        // PFX-A: userData.particles is the emitter config (Inspector/menus set
        // it); the particle runtime sweeps it per tick. null = removed
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        if (mesh) {
            if (data.particles) mesh.userData.particles = data.particles;
            else delete mesh.userData.particles;
            pokeScene();
        }
    } else if (data.parameter == 'device') {
        // 23-A3: userData.device is a device object's whole configuration ({kind,
        // params}); the runtime rebuilds its WebAudio subgraph from it. null = removed.
        applyRemoteDevice(data);
    } else if (data.parameter == 'camera') {
        // 16-P5: userData.camera holds a camera OBJECT's lens + framing settings
        // (the marker is a normal mesh; the preview camera and the frustum viz are
        // built from this at the scene root). null = cleared.
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        if (mesh) {
            if (data.camera) mesh.userData.camera = data.camera;
            else delete mesh.userData.camera;
            pokeScene(); // frustum viz + preview re-read
        }
    } else if (data.parameter == 'renderOrder') {
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        if (mesh) mesh.renderOrder = data.renderOrder;
    } else if (data.parameter == 'frustumCulled') {
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        if (mesh) mesh.frustumCulled = data.frustumCulled;
    }
}

export async function deleteObject(uuid) {
    let object = sceneObjects.getObjectByProperty('uuid', uuid)
    if (!object) return;
    const keep = keepSet(sceneRoot(), object);
    object.parent?.remove(object);
    if(selected?.uuid == uuid) controls.detach();
    sceneObjects.remove(sceneObjects.getObjectByProperty('uuid', uuid));
    disposeTree(object, { keep });
    //Trigger reactivity for UI list of objects on remote
    pokeScene();
}


/**
 * R22 round 32 — WHAT `override` MEANS, in both paths.
 *
 * The default is DEDUPE BY UUID: an object we already hold is left exactly as it is, which
 * is what makes a re-sent handshake harmless. It is also why a re-sync could never HEAL
 * anything — the arrival re-sync added the objects the traveller was missing and left every
 * shared uuid pinned to whatever pose the .tpscene was saved with, so two peers stood in
 * one room looking at two worlds and nothing on the wire could ever close the gap.
 *
 * `override` says "replace the one you have with this one". Two senders predate this and
 * both aim it at a target they know exists (Inspector's light resend, environment's preset
 * light); the third is the arrival heal, which aims it at a whole scene and therefore MUST
 * tolerate a uuid we do not hold — an override for an unknown object is just a create.
 * @param {any} object @param {string[]|null} uuid @param {boolean} [override]
 * @param {string} [groupuuid] @param {number[]} [pos] @param {number[]} [rot] @param {number[]} [scale]
 */
export async function createObject(object, uuid, override, groupuuid, pos, rot, scale) {
    return enqueueIngest([object, uuid, override, groupuuid, pos, rot, scale]);
}

// ---------------------------------------------------------------------------
// 26-B (roadmap 26 Stage 0) — TIME-SLICED INGEST.
//
// The dispatcher calls `createObject` once per incoming `object` message and never
// awaits it, so a 1,000-object handshake used to start 1,000 overlapping parses in the
// same task: `GLTFLoader.parse` is main-thread by design, so the tab had no frame to
// give anyone until the last one finished. Ordering was also only accidental — two
// parses that resolved out of order could attach a child before its group existed.
//
// The queue fixes both with one mechanism. Objects are applied STRICTLY IN THE ORDER
// RECEIVED, and the drainer yields to the event loop every SLICE_MS of work, so input,
// rendering and the poke flush all get a turn while a big scene lands. A batch is open
// for the whole drain, which is what puts `pokeScene` into its one-per-frame mode.
//
// A macrotask (setTimeout 0) is the yield, not a microtask: a microtask chain never
// returns to the browser, so it would slice the work without ever letting a frame run.
// ---------------------------------------------------------------------------

/** How long the drainer may hold the thread before yielding. 8ms leaves half a 60Hz
 * frame for everything else. */
const INGEST_SLICE_MS = 8;

/** @type {{args: any[], resolve: (v?: any) => void, reject: (e: any) => void}[]} */
let ingestQueue = [];
let ingestDraining = false;

// ---------------------------------------------------------------------------
// 26-C (roadmap 26 Stage 2) — THE INGEST GATE.
//
// A scene arriving over the wire announces itself first (`{type:'loading', count,
// uuids}`) and only then sends the objects, so there is exactly one moment where the
// size is known and nothing has been applied yet. Past that moment a 4,000-object scene
// is simply happening to you.
//
// The queue built in 26-B is already the parking mechanism: HOLDING it parks every
// object that arrives, parsed or not, with no second code path and nothing to unwind.
// The fork is three-way because a stream is divisible — half a room's scenery is a
// usable scene, and the alternative to "load the first N" is all-or-nothing on somebody
// else's content.
//
// LOCAL ONLY. Nothing here is sent: the peer is not told we declined, because that is a
// fact about THIS device's budget and there is nothing for them to do about it. They
// see us with fewer objects, which is what actually happened.
// ---------------------------------------------------------------------------

/** The open question, or null. Toasts.svelte MIRRORS this into one sticky card (the
 * `restoreAvailable` idiom) rather than this module importing the UI. */
/** @type {import('svelte/store').Writable<{count: number, allowed: number, total: number, limit: number, sender: string | null} | null>} */
export const ingestGate = writable(null);

let ingestHeld = false;
/** How many more objects this drain may apply before dropping the rest. Infinity = no
 * cap, which is every path that never met a gate. */
let ingestCap = Infinity;

/** How many objects the scene already holds — the walk the verdict is measured against. */
function liveObjectCount() {
    let n = 0;
    sceneObjects?.traverse?.((/** @type {any} */ o) => {
        if (o !== sceneObjects) n++;
    });
    return n;
}

/**
 * Answer the fork. 'all' releases everything, 'some' applies up to the budget and drops
 * the rest, 'cancel' drops the lot.
 * @param {'all'|'some'|'cancel'} answer
 */
export function resolveIngestGate(answer) {
    const open = get(ingestGate);
    if (!open) return 0;
    ingestGate.set(null);
    ingestHeld = false;
    if (answer === 'cancel') {
        const dropped = dropIngestQueue();
        clearLoadingBatch();
        showToast('Cancelled — ' + open.count + ' objects were not loaded.');
        return dropped;
    }
    ingestCap = answer === 'some' ? open.allowed : Infinity;
    // the stall timer was parked while the question was open; the transfer resumes now
    armLoadingStall();
    if (!ingestDraining && ingestQueue.length) {
        ingestDraining = true;
        beginSceneBatch();
        void drainIngest();
    }
    if (answer === 'some')
        showToast('Loading the first ' + open.allowed + ' of ' + open.count + ' objects.');
    return ingestQueue.length;
}

/** Is a fork open? Read by the suite. */
export function ingestGateOpen() {
    return ingestHeld;
}

/** @param {any[]} args */
function enqueueIngest(args) {
    return new Promise((resolve, reject) => {
        ingestQueue.push({ args, resolve, reject });
        if (!ingestDraining) {
            ingestDraining = true;
            beginSceneBatch();
            void drainIngest();
        }
    });
}

async function drainIngest() {
    try {
        while (ingestQueue.length && !ingestHeld) {
            const started = performance.now();
            while (ingestQueue.length && performance.now() - started < INGEST_SLICE_MS) {
                const job = ingestQueue.shift();
                if (!job) break;
                if (ingestCap <= 0) {
                    // over the budget the user agreed to: the object is DROPPED, and its
                    // uuid is counted as arrived so the progress bar does not wait out
                    // the full stall for something that is never coming
                    const uuid = job.args[1];
                    noteLoadFailed(Array.isArray(uuid) ? uuid : []);
                    job.resolve(undefined);
                    continue;
                }
                try {
                    // @ts-ignore - spread of a fixed-length arg tuple
                    job.resolve(await applyCreateObject(...job.args));
                    if (Number.isFinite(ingestCap)) ingestCap--;
                } catch (error) {
                    // a parse that rejects is still an ARRIVAL as far as the progress bar
                    // is concerned, or the batch waits out the full 60s stall
                    console.log('Failed to create an incoming object: ' + error);
                    const uuid = job.args[1];
                    noteLoadFailed(Array.isArray(uuid) ? uuid : [job.args[0]?.element?.object?.uuid].filter(Boolean));
                    job.reject(error);
                }
            }
            if (ingestQueue.length && !ingestHeld) await new Promise((r) => setTimeout(r, 0));
        }
    } finally {
        ingestDraining = false;
        endSceneBatch();
        if (!ingestQueue.length) ingestCap = Infinity;
    }
}

/** A peer wiped the scene, or we did: whatever is still parked is about to be wrong.
 * (Roadmap 26 section 5 — "the ingest queue drops on clear".) */
export function dropIngestQueue() {
    ingestHeld = false;
    ingestCap = Infinity;
    ingestGate.set(null);
    if (!ingestQueue.length) return 0;
    const dropped = ingestQueue.length;
    for (const job of ingestQueue) job.resolve(undefined);
    ingestQueue = [];
    return dropped;
}

/** How many objects are parked. Read by the suite and the 26-A meter. */
export function ingestBacklog() {
    return ingestQueue.length;
}
registerMetricSource('ingestBacklog', ingestBacklog);

/**
 * @param {any} object @param {string[]|null} uuid @param {boolean} [override]
 * @param {string} [groupuuid] @param {number[]} [pos] @param {number[]} [rot] @param {number[]} [scale]
 */
async function applyCreateObject(object, uuid, override, groupuuid, pos, rot, scale) {
    let parent;
    if (uuid == null) {
    let mesh = loader.parse(object.element);
    // an incoming object can only carry a STALE edit wireframe (a peer on an
    // older build, or a scene saved with a session open) — never a live one
    stripEditOverlays(mesh);
    let existing = override ? sceneObjects.getObjectByProperty('uuid', mesh.uuid) : null;
    if (existing) {
        // replace IN PLACE, under the same parent. The gizmo has to let go first or it
        // keeps steering an object that is no longer in the scene (deleteObject's rule).
        if (controls?.object?.uuid === existing.uuid) controls.detach();
        parent = existing.parent ?? sceneObjects;
        parent.remove(existing);
        parent.add(mesh)
        // AFTER the replacement is in the scene: anything the two share is then in the
        // keep set and survives, which a dispose before the add would have freed.
        disposeTree(existing, { keep: keepSet(sceneRoot(), existing) });
    } else if (sceneObjects.getObjectByProperty('uuid', mesh.uuid) == null) {
        // …and an override for something we never had falls through to here. It used to
        // read `overrideObject.parent` unconditionally and THROW on null.
        let group = sceneObjects.getObjectByProperty('uuid', groupuuid)
        if (group) group.add(mesh)
        else sceneObjects.add(mesh);
    }
    } else {
        // console.log("Adding GLTF object " + uuid)
        const loader = new GLTFLoader();
        const result = await new Promise((resolve, reject) => {
          loader.parse(object.element, '', (gltf) => resolve(gltf), (error) => reject(error));
        });
        result.scene.uuid = uuid
        result.scene.children.forEach((object, index) => {
          let mesh = object.clone()
          mesh.uuid = uuid[index]
          object.uuid = uuid[index]
          const existing = sceneObjects.getObjectByProperty('uuid', mesh.uuid)
          if (existing) {
              // NEVER a second copy of one uuid. The old shape added conditionally and
              // then ran the `groupuuid` block unconditionally (the indentation lies —
              // there are no braces), so an override ADDED the fresh mesh beside the old
              // one, and even a plain re-send attached a duplicate into the group.
              if (!override) return;
              if (controls?.object?.uuid === existing.uuid) controls.detach();
              const keepExisting = keepSet(sceneRoot(), existing);
              existing.parent?.remove(existing);
              disposeTree(existing, { keep: keepExisting });
          }
          sceneObjects.add(mesh)
            if (groupuuid){
                let group = sceneObjects.getObjectByProperty('uuid', groupuuid)
                if (group) group.attach(mesh)
                // if (group.parent.parent.parent !== null) {
                // mesh.position.set(0, 0, 0);
                // mesh.rotation.set(0, 0, 0);
                // mesh.scale.set(1, 1, 1);
                // } else {
                if(pos && rot && scale) {
                    mesh.position.set(pos[0], pos[1], pos[2]);
                    mesh.rotation.set(rot[0], rot[1], rot[2]);
                    mesh.scale.set(scale[0], scale[1], scale[2]);
                }
            } else if (override && pos && rot && scale) {
                // a heal of a TOP-LEVEL mesh: the exported bytes carry the sender's pose,
                // but the message says it in numbers and this is the one path that exists
                // to converge a pose — say it with the numbers.
                mesh.position.set(pos[0], pos[1], pos[2]);
                mesh.rotation.set(rot[0], rot[1], rot[2]);
                mesh.scale.set(scale[0], scale[1], scale[2]);
            }
        });
    }
    //Trigger reactivity for UI list of objects
    pokeScene();
}

/**
 * Sends all objects in the scene to the given peer.
 * @param {string} peerId - The ID of the peer to send the objects to.
 * @param {any} [element] - subtree to send (the null-peerId group path); absent = the whole scene
 * @param {{override?: boolean}} [opts] - R22 round 32: `override` marks this send as an
 *   ARRIVAL HEAL, so the receiver REPLACES the objects it already holds instead of
 *   deduping them away. Set by exactly one caller (the `arriving` row of
 *   `deferUntilShareChoice`); absent everywhere else, and when absent every message this
 *   walk emits is byte-identical to what it always sent.
 */
export function sendObjects(peerId, element, opts = {}) {
    let groupid;
    if (peerId === null) {
        groupid = element.uuid;
        peer.send({type: 'group', name: element.name, uuid: element.uuid, groupparent: null,
            pos: element.position.toArray(),
            rot: element.rotation.toArray(),
            scale: element.scale.toArray(),
            ...(opts.override ? { override: true } : {})
        });
    }

    // 26-B (audit M1): the uuid list is built PER CALL. It used to be a module-level
    // array that `countObjects` PUSHED onto and only the timer emptied, so two
    // approvals 400ms apart both counted into it: the second joiner was told to expect
    // the first joiner's objects too and its progress bar read "12/40" forever, while
    // `count` itself was the RUNNING TOTAL rather than this send's.
    const uuidList = [];
    const count = countObjects(element, uuidList);
    console.log("Sending " + count + " objects to " + peerId);

    // Wait 500ms to ensure the connection is established before sending the objects
    setTimeout(() => {
        // …and RESOLVE THE CONNECTION HERE, not 500ms ago. `peer.connections[peerId]`
        // is undefined while the dial is still in flight and closed when the joiner
        // gave up in between; both used to throw INSIDE A TIMER, where nothing catches
        // it — the handshake reply simply vanished with an uncaught TypeError.
        const conn = peerId === null ? peer : peer?.connections?.[peerId];
        if (!conn || (peerId !== null && !conn.open)) {
            console.log('Not sending ' + count + ' objects to ' + peerId + ': the connection is gone');
            return;
        }
        // Send amount of objects to be sent and their uuids
        conn.send({type: 'loading', count: count, uuids: uuidList});
        // park animated objects at their base pose so the receiver captures the
        // TRUE animation base, not a mid-swing pose (88). The walk below reads
        // every transform synchronously, so restore right after.
        const restore = parkAnimatedAtBase();
        try {
            sendObject(conn, element, groupid, opts);
        } finally {
            restore();
        }
    }, 500);

}

/**
 * Should this leaf mesh be sent as toJSON instead of GLTF? Only a MATERIAL ARRAY
 * needs it (GLTF loses the array — see the branch that uses this).
 *
 * Size is the catch: toJSON writes geometry attributes as PLAIN NUMBER ARRAYS, and
 * binarypack recurses per element, so a big mesh blows the call stack and
 * `broadcast`'s catch swallows it — the message would silently never leave. The GLTF
 * path packs attributes as base64 and has no such limit, so above the cap we fall
 * back to it and accept losing the slots rather than losing the object.
 * @param {any} element
 */
function multiMaterialSyncable(element) {
    if (!isMultiMaterial(element)) return false;
    const position = element.geometry?.attributes?.position;
    // 45000 floats, and this one does NOT follow the raised meshBudget ceiling:
    // that ceiling was raised because RAW BYTES ride the wire fine (12 MB measured),
    // while this path sends toJSON's PLAIN NUMBER ARRAYS, whose limit is binarypack's
    // per-element recursion — an unrelated constraint that did not move.
    if (position && position.count * 3 > 45000) {
        showToast('"' + (element.name || element.type) + '" is too large to share its material slots');
        return false;
    }
    return true;
}

/**
 * @param {any} conn @param {any} element @param {string|undefined} groupuuid
 * @param {{override?: boolean}} [opts] see `sendObjects` — threaded through EVERY
 *   recursive call, because a subtree of an arrival heal is still an arrival heal.
 */
export function sendObject(conn, element, groupuuid, opts = {}) {
    // spread into every outgoing message: present only for an arrival heal, so an
    // ordinary handshake reply stays byte-identical (the `labels`-when-empty precedent)
    const heal = opts.override ? { override: true } : {};
    let objects = [];
    let test = new THREE.Vector3();
    if (typeof element !== 'undefined') {
        objects = element.children;
    } else {
        objects = sceneObjects.children;
    }
    // Iterate over all objects in the scene
    objects.forEach(element => {
        // viewer perms: never sync a viewer's local-only objects to a peer
        if (element.userData && element.userData.__localOnly) return;
        if (hasAnimatedImport(element.uuid)) {
            // rigs travel as their original file bytes, one message
            sendAnimatedImport(conn, element, opts);
        } else if (element.type == "Group") {
            if (element.parent.parent.parent !== null) {
                groupuuid = element.parent.uuid
                // console.log("group uuid: " + groupuuid);
            }
            element.getWorldPosition(test);
            conn.send({
                type: 'group',
                name: element.name,
                uuid: element.uuid,
                groupparent: groupuuid,
                pos: test.toArray(),
                rot: element.rotation.toArray(),
                scale: element.scale.toArray(),
                // 23-C1 fix: a Group can CARRY data (a device whose mesh() is a Group keeps
                // its whole document in userData.device) — additive, absent on the /group
                // command path and ignored by an older receiver
                ...(element.userData && Object.keys(element.userData).length ? { userData: element.userData } : {}),
                ...heal
            });
            // the 4th argument used to be a stray `groupuuid` that the 3-parameter
            // signature silently dropped — it is `opts` now, which is what a recursion
            // into a subtree of an arrival heal has to carry
            sendObject(conn, element, element.uuid, opts);
        } else if (element.type.endsWith('Light')) {
            element.getWorldPosition(test);
            groupuuid = element.parent.uuid
            // Send each object as a JSON object
            conn.send({
                type: 'object',
                element: element.toJSON(),
                groupuuid: groupuuid,
                pos: test.toArray(),
                rot: element.rotation.toArray(),
                scale: element.scale.toArray(),
                ...heal
            });
        } else if (element.children.length > 0) {
            //send only this object without children
            //then use send objects to send children
            element.getWorldPosition(test);
            groupuuid = element.parent.uuid
            // Send each object as a JSON object
            let elementClone = element.clone();
            elementClone.uuid = element.uuid;
            elementClone.children = [];
            conn.send({
                type: 'object',
                element: elementClone.toJSON(),
                groupuuid: groupuuid,
                pos: test.toArray(),
                rot: element.rotation.toArray(),
                scale: element.scale.toArray(),
                ...heal
            });
            sendObject(conn, element, element.uuid, opts);
        } else if (multiMaterialSyncable(element)) {
            // A MATERIAL ARRAY cannot survive the GLTF round trip: the exporter
            // splits geometry.groups into one primitive per material and the loader
            // reassembles that as a GROUP of single-material child meshes, so the
            // receiver ends up with a Group (0 slots, 0 groups, fresh child uuids)
            // instead of the mesh — measured in tests/e2e/object-sync. toJSON +
            // ObjectLoader DOES round-trip arrays, geometry.groups and data-URL
            // textures, which is why lights, parent meshes, convert-to-mesh, prefabs
            // and sessions all already use it (see objectActions' note on the rule).
            conn.send({
                type: 'object',
                element: serializeMeshWithGroups(element),
                groupuuid: groupuuid,
                pos: element.position.toArray(),
                rot: element.rotation.toArray(),
                scale: element.scale.toArray(),
                ...heal
            });
        } else {
            // capture the transform NOW (synchronously, while animated objects
            // are parked at their base) — the exporter callback fires later (88)
            const pos = element.position.toArray();
            const rot = element.rotation.toArray();
            const scale = element.scale.toArray();
            const exporter = new GLTFExporter();
            exporter.parse(
                element,
                function (result) {
                    conn.send({
                        type: 'object',
                        element: result,
                        uuids: [element.uuid],
                        groupuuid: groupuuid,
                        pos: pos,
                        rot: rot,
                        scale: scale,
                        ...heal
                    });
                },
                function (error) {
                    // an export failure used to be invisible: nothing was sent and
                    // nothing said so, leaving a hole in the receiver's scene
                    console.log(error);
                    showToast('Could not share "' + (element.name || element.type) + '" with peers');
                },
                // OPTIONS ARE THE FOURTH ARGUMENT OF parse(), not the constructor. three's
                // GLTFExporter constructor takes none, so `new GLTFExporter({...})` silently
                // discarded them — which is why the long-standing `{outputEncoding: 'json'}`
                // here never did anything either.
                //
                // onlyVisible: FALSE matters because three DEFAULTS IT TO TRUE, so any object
                // hidden locally is omitted from the export and the peer never receives it at
                // all — a local hide becomes a DELETE for every late joiner. Found through the
                // camera preview, which hides the marker it is looking through: a peer joining
                // mid-game then had no such camera and could not follow the game to it
                // (measured: the box arrived, the previewed camera did not). A hidden object
                // must replicate; the receiver simply shows it.
                { onlyVisible: false }
            );
        }
    })

}

/** @param {any} element @param {string[]} sink the CALLER's uuid list (audit M1) */
function countObjects(element, sink) {
    let objects = [];
    if (typeof element !== 'undefined') {
        objects = element.children;
    } else {
        objects = sceneObjects.children;
    }
    objects.forEach(element => {
        if (element.type == "Group" && !hasAnimatedImport(element.uuid)) {
            countObjects(element, sink);
        }
        sink.push(element.uuid)
    })
    return sink.length;
}
