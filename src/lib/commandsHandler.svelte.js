import * as THREE from 'three';
import { globalScene, objectsGroup, showGrid, TControls, lockedObjects, selectedObject, globalCamera, peerHands } from '../stores/sceneStore.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGeometry, createLight, createGroup } from '$lib/geometries.svelte'
import { applyMap, switchMaterialType, setMaterialParam } from '$lib/materialsHandler'
import { recordObjectPresence } from '$lib/history'
import { voicePeerDisconnected } from '$lib/voiceChat'
import { physicsPeerDisconnected, physicsShapeChanged } from '$lib/physics'
import { dropPeerCursor } from '$lib/nodesHandler'
import { dropPeerQuality } from '$lib/networkQuality'
import { sessionHost, dropPeerJoined } from '$lib/connectionState'
import { environment } from '$lib/environment'
import { hasAnimatedImport, sendAnimatedImport, setAnimationState, dropAllAnimatedImports } from '$lib/animatedImports'
import { parkAnimatedAtBase } from '$lib/flowRuntime'
import { runSceneClearHandlers } from '$lib/moduleSDK'
import { annotations } from '$lib/annotationsHandler'
import { isViewer, warnViewerReadOnly } from '$lib/objectPermissions'
import { get } from 'svelte/store'
import { addMessage, loading, loadingcount, showToast, fixLight, specatorMode } from '../stores/appStore';
import { peers, userdata } from '../stores/appStore';

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

let uuids = [];

export function userData(data) {
    data.forEach(element => {
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

export function specator(data, specator) {
    if ( specator === 'false') {
        let index = users.findIndex(u => u[0] === data.peerId);
        users[index][3] = null;
        return;
    }
    scene.getObjectByName(data.peerId).position.set(0, 1000, 0);
    let index = users.findIndex(u => u[0] === data.peerId);
    users[index][3] = specator;
}

export function cameraSettings(data) {
    // console.log('peer sent camera settings: ' + data.fov);
    if ( data.fov ) {
        let index = users.findIndex(u => u[0] === data.peerId);
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
                    recordObjectPresence('delete', object);
                    // parent-aware so nested objects are removed too
                    (object.parent ?? sceneObjects).remove(object);
                }
                peer.send({type: 'delete', uuid: command.split(' ')[1], peerId: peer.peer.id});
            }
        }
        else if (command.startsWith('/grid')) {
            if (command.split(' ')[1] == 'on')
            {
                showGrid.set(true);
                localStorage.removeItem('showGrid')
            }
            else if (command.split(' ')[1] == 'off')
            {
                showGrid.set(false);
                localStorage.setItem('showGrid', false);
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
    objectsGroup.update((value) => value);
}

/**
 * Full local scene wipe (both the local /clear all and the clearscene message):
 * objects, module viewport content, annotations, locks and byte registries.
 */
export function clearSceneLocal() {
    controls?.detach();
    sceneObjects?.clear();
    runSceneClearHandlers(); // modules remove their scene-root content
    annotations.set([]);
    lockedObjects.set([]);
    // animated-import bytes/mixers are per-object — all gone now
    dropAllAnimatedImports();
    objectsGroup.update((value) => value);
}

/** A peer wiped the shared scene @param {string} peerId */
export function applyClearScene(peerId) {
    clearSceneLocal();
    showToast(peerId + ' cleared the scene');
}

export function lockRestore(lockeditems) {
    // Filter out the current peer id locks
    locked = locked.concat(lockeditems.filter((lock) => lock[0] != peer.peer.id));
    // Update the locked objects store
    lockedObjects.set(locked);
}

export function handleDisconnected(peerId) {
    console.log(peerId + ' disconnected');
    // Full per-peer teardown, idempotent so it's safe to run from both the
    // conn-close path AND a relayed 'disconnected' message. Toast only while the
    // peer is still known, so relayed duplicates don't stack toasts (172).
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
    // CN: host bookkeeping — the host leaving means we're no longer "joined"
    if (get(sessionHost) === peerId) sessionHost.set(null);
    dropPeerJoined(peerId);
    voicePeerDisconnected(peerId);
    physicsPeerDisconnected(peerId);
}

export function checkLocks(data) {


    // console.log(users);
    // console.log("this.connections")
    // console.log(peer.peer.connections)

    setTimeout(() => {

    users.forEach(user => {
        const connection = peer.peer.connections[user[0]];
        if (user[0] === peer.peer.id) return true; // ignore current peerId
        if (!connection || connection.length < 1) {
            peer.send({type: 'disconnected', peerId: user[0]});
            console.log("send disconnect of " + user[0])
            users = users.filter(u => u[0] !== user[0]);
            userdata.set(users);
            userdata.update((value) => value);
        }
    });
        
        }, 500)


    // console.log(peer.peer.connections);
    
    locked.forEach((objectLock) => {

        if(!peer.peer.connections[objectLock[0]]) {
            console.log('Connection ' + objectLock[0] + ' not found. Releasing...');
            // release THIS gone peer's lock (was inverted: kept it, dropped others)
            locked = locked.filter((lockedUuid) => lockedUuid[1] != objectLock[1]);
        } else if(peer.peer.connections[objectLock[0]].length <= 1) {
            console.log('Peer ' + objectLock[0] + ' is not connected anymore. Releasing...' + objectLock[1]);
            locked = locked.filter((lockedUuid) => lockedUuid[1] != objectLock[1]);
        }
        lockedObjects.set(locked);

    })
    
}

export async function createLoader(count, uuids) {
    // console.log("create loader for " + count + " objects: " + uuids);
    loading.set(uuids);
    loadingcount.set(count);
    //Trigger reactivity for UI list of objects on remote
    loading.update((value) => value);
    //Trigger reactivity for UI list of objects on remote
    loadingcount.update((value) => value);
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
    } else if (data.parameter == 'map') {
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        if (mesh) applyMap(mesh, data.map);
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
            objectsGroup.update((value) => value);
        }
    } else if (data.parameter == 'physics') {
        // P-A: userData.physics is the source of truth for the Inspector-set
        // body params (mode/mass/restitution/friction/collider); null = cleared
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        if (mesh) {
            if (data.physics) mesh.userData.physics = data.physics;
            else delete mesh.userData.physics;
            objectsGroup.update((value) => value); // collider viz re-syncs
            physicsShapeChanged(data.uuid); // CL-A A2: live mid-sim rebuild
        }
    } else if (data.parameter == 'particles') {
        // PFX-A: userData.particles is the emitter config (Inspector/menus set
        // it); the particle runtime sweeps it per tick. null = removed
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        if (mesh) {
            if (data.particles) mesh.userData.particles = data.particles;
            else delete mesh.userData.particles;
            objectsGroup.update((value) => value);
        }
    } else if (data.parameter == 'camera') {
        // 16-P5: userData.camera holds a camera OBJECT's lens + framing settings
        // (the marker is a normal mesh; the preview camera and the frustum viz are
        // built from this at the scene root). null = cleared.
        let mesh = sceneObjects.getObjectByProperty('uuid', data.uuid);
        if (mesh) {
            if (data.camera) mesh.userData.camera = data.camera;
            else delete mesh.userData.camera;
            objectsGroup.update((value) => value); // frustum viz + preview re-read
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
    object.parent?.remove(object);
    if(selected?.uuid == uuid) controls.detach();
    sceneObjects.remove(sceneObjects.getObjectByProperty('uuid', uuid));
    //Trigger reactivity for UI list of objects on remote
    objectsGroup.update((value) => value);
}


export async function createObject(object, uuid, override, groupuuid, pos, rot, scale) {
    let parent;
    if (uuid == null) {
    let mesh = loader.parse(object.element);
    if (override) {
        let overrideObject = sceneObjects.getObjectByProperty('uuid', mesh.uuid)
        parent = overrideObject.parent
        parent.remove(overrideObject);
        parent.add(mesh)
    } else if (sceneObjects.getObjectByProperty('uuid', mesh.uuid) == null || override) {
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
          if (sceneObjects.getObjectByProperty('uuid', mesh.uuid) == null || override)
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
            }
        });
    }
    //Trigger reactivity for UI list of objects
    objectsGroup.update((value) => value);
}

/**
 * Sends all objects in the scene to the given peer.
 * @param {string} peerId - The ID of the peer to send the objects to.
 */
export function sendObjects(peerId, element) {
    let conn; let groupid;
    if (peerId === null) {
        groupid = element.uuid;
        conn = peer;
        conn.send({type: 'group', name: element.name, uuid: element.uuid, groupparent: null,
            pos: element.position.toArray(),
            rot: element.rotation.toArray(),
            scale: element.scale.toArray()
        });
    }
    else
    conn = peer.connections[peerId];

    let objects = [];

    // Iterate over all objects in the scene
    let count = countObjects(element);
    console.log("Sending " + count + " objects to " + peerId);

    // Wait 500ms to ensure the connection is established before sending the objects
    setTimeout(() => {
        // Send amount of objects to be sent and their uuids
        conn.send({type: 'loading', count: count, uuids: uuids});
        // park animated objects at their base pose so the receiver captures the
        // TRUE animation base, not a mid-swing pose (88). The walk below reads
        // every transform synchronously, so restore right after.
        const restore = parkAnimatedAtBase();
        try {
            sendObject(conn, element, groupid);
        } finally {
            restore();
        }
        uuids = [];
    }, 500);

}

export function sendObject(conn, element, groupuuid) {
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
            sendAnimatedImport(conn, element);
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
                scale: element.scale.toArray()
            });
            sendObject(conn, element, element.uuid, groupuuid);
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
                scale: element.scale.toArray()
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
                scale: element.scale.toArray()
            });
            sendObject(conn, element, element.uuid);
        } else {
            // capture the transform NOW (synchronously, while animated objects
            // are parked at their base) — the exporter callback fires later (88)
            const pos = element.position.toArray();
            const rot = element.rotation.toArray();
            const scale = element.scale.toArray();
            const exporter = new GLTFExporter({outputEncoding: 'json'});
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
                        scale: scale
                    });
                },
                function (error) {
                    console.log(error);
                }
            );
        }
    })

}

function countObjects(element) {
    let objects = [];
    if (typeof element !== 'undefined') {
        objects = element.children;
    } else {
        objects = sceneObjects.children;
    }
    objects.forEach(element => {
        if (element.type == "Group" && !hasAnimatedImport(element.uuid)) {
            countObjects(element);
        }
        uuids.push(element.uuid)
    })
    // console.log(uuids.length)
    return uuids.length;
}
