import * as THREE from 'three';
import { toggleExpand, fixLight } from '../stores/appStore.js';
import { customGeometryBuilders } from '$lib/customGeometries';
import { notifyExternalMove } from '$lib/flowRuntime';
import { globalScene, objectsGroup, TControls, lockedObjects, selectedObject } from '../stores/sceneStore.js';

//Access scene Store
let scene = $state();
globalScene.subscribe(value => { scene = value });

//Access objects Store
let sceneObjects = $state();
objectsGroup.subscribe(value => { sceneObjects = value });

//Access object controls
let controls = $state();
TControls.subscribe(value => { controls = value });

//Access locked objects
let locked = $state();
lockedObjects.subscribe(value => { locked = value });

/**
 * Creates a THREE.js geometry object based on the given command string.
 * The geometry name is extracted from the command string, and the options
 * are passed as an array of strings to the geometry constructor.
 *
 * @param {string} command - The command string to parse, e.g. "/create sphere 1 2 3"
 * @param {string} uuid - The UUID to assign to the created geometry (optional)
 * @returns {string|null} The UUID of the created geometry, or null if the geometry is invalid
 */

export function createGeometry(command, uuid) {
    let geometry = command.split(' ')[1]
    geometry = geometry.charAt(0).toUpperCase() + geometry.slice(1)
    // numbers, not strings: geometry constructors that ADD parameters
    // (Torus: radius + tube*cos) would string-concatenate otherwise and
    // produce exploded meshes; missing args stay undefined for defaults
    let options = [2, 3, 4, 5].map((index) => {
        const value = parseFloat(command.split(' ')[index]);
        return Number.isNaN(value) ? undefined : value;
    });
    let geometryList = ["Box","Capsule","Circle","Cone","Cylinder","Dodecahedron","Edges","Extrude","Icosahedron","Lathe","Octahedron","Plane","Polyhedron","Ring","Shape","Sphere","Tetrahedron","Torus","TorusKnot","Tube","Wireframe"]
    if (customGeometryBuilders[geometry] || geometryList.includes(geometry)) {
        let mesh = customGeometryBuilders[geometry]
            ? customGeometryBuilders[geometry](options[0],options[1],options[2],options[3])
            : new (/** @type {any} */ (THREE))[geometry+'Geometry'](options[0],options[1],options[2],options[3]);
        let material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
        let object = new THREE.Mesh(mesh, material);
        if (uuid) object.uuid = uuid
        object.name = geometry;
        sceneObjects.add(object);
        //Trigger reactivity for UI list of objects
        objectsGroup.update((value) => value);
        // console.log('createGeometry: ' + geometry);
        if (!uuid) controls.attach(object);
        if (!uuid) selectedObject.set(object);
        return object.uuid
    } else {
        console.log('Invalid geometry: ' + geometry);
        return null
    }
}

export function createLight(command, uuid) {
    let lightType = command.split(' ')[1].toLowerCase();
    let light;
    if (lightType == 'ambient') {
        light = new THREE.AmbientLight(0xffffff, 1);
        light.name = 'Ambient';
    } else if (lightType == 'directional') {
        light = new THREE.DirectionalLight(0xffffff, 1);
        light.name = 'Directional';
    } else if (lightType == 'point') {
        light = new THREE.PointLight(0xffffff, 1);
        light.name = 'Point';
    } else if (lightType == 'spot') {
        light = new THREE.SpotLight(0xffffff, 1);
        light.name = 'Spot';
    } else if (lightType == 'hemisphere') {
        light = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
        light.name = 'Hemisphere';
        if (uuid) light.uuid = uuid
    } else if ( lightType == 'rectArea') {
        light = new THREE.RectAreaLight(0xffffff, 1, 10, 10);
        light.name = 'RectArea';
    } else {
        console.log('Invalid light: ' + light);
        return null
    }       
    if (light){
        fixLight.set(false);
        if (uuid) light.uuid = uuid
        sceneObjects.add(light);
        //Trigger reactivity for UI list of objects
        objectsGroup.update((value) => value);
        // console.log('createLight: ' + light);
        if (!uuid) controls.attach(light);
        if (!uuid) selectedObject.set(light);
        return light.uuid
    }
}

export function createGroup(command, uuid, groupuuid, name, groupparent, pos, rot, scale) {
    let group;
    if (groupuuid) {
        let group = sceneObjects.getObjectByProperty('uuid', groupuuid);
        let mesh = sceneObjects.getObjectByProperty('uuid', uuid);
        if (groupuuid == 'up')
        group = mesh.parent.parent;
        toggleExpand.set(group.uuid);
        group.attach(mesh);
        if(pos && rot && scale) {
            group.position.set(pos[0], pos[1], pos[2]);
            group.rotation.set(rot[0], rot[1], rot[2]);
            group.scale.set(scale[0], scale[1], scale[2]);
        }
        //Trigger reactivity for UI list of objects
        objectsGroup.update((value) => value);
        return group.uuid
    } else {
        let group = new THREE.Group();
        if (command?.split(' ')[1]) group.name = command.split(' ')[1] + ' Group';
        else group.name = name
        if (uuid) group.uuid = uuid
        sceneObjects.add(group);
        if(pos && rot && scale) {
            group.position.set(pos[0], pos[1], pos[2]);
            group.rotation.set(rot[0], rot[1], rot[2]);
            group.scale.set(scale[0], scale[1], scale[2]);
        }
        
        //Trigger reactivity for UI list of objects
        objectsGroup.update((value) => value);
        // console.log('createGroup: ' + group);
        if (!uuid) controls.attach(group);
        if (!uuid) selectedObject.set(group);
        // Attach the group to its parent, if specified
        if (groupparent) {
            let groupParent = sceneObjects.getObjectByProperty('uuid', groupparent)
            if (groupParent) groupParent.attach(group);
            else sceneObjects.attach(group);
            if(pos && rot && scale) {
                group.position.set(pos[0], pos[1], pos[2]);
                group.rotation.set(rot[0], rot[1], rot[2]);
                group.scale.set(scale[0], scale[1], scale[2]);
            }
        }
        return group.uuid
    }

}

export function changeName(uuid, name) {
    if(sceneObjects.getObjectByProperty('uuid', uuid)) {
        sceneObjects.getObjectByProperty('uuid', uuid).name = name;
        //Trigger reactivity for UI list of objects
        objectsGroup.update((value) => value);
    }
}
   
export function moveGeometry(uuid, pos, rot, scale) {
    if(sceneObjects.getObjectByProperty('uuid', uuid)) {
        sceneObjects.getObjectByProperty('uuid', uuid).position.set(pos[0], pos[1], pos[2]);
        sceneObjects.getObjectByProperty('uuid', uuid).rotation.set(rot[0], rot[1], rot[2]);
        sceneObjects.getObjectByProperty('uuid', uuid).scale.set(scale[0], scale[1], scale[2]);
        // a peer moved it: if it is animated here, this transform is the new base
        notifyExternalMove(uuid);
    }
}

export function moveCamera(data) {
    // console.log('moveCamera: ' + data.position[1] + ' ' + data.rotation[1]);
    let peerMesh = scene.getObjectByName(data.peerId)
    if (!peerMesh) return;
    peerMesh.position.set(data.position[0], data.position[1], data.position[2]);
    peerMesh.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2]);
}

/**
 * Locks objects for a peer, replacing that peer's previous lock set.
 * Multi-select (13) sends `uuids`; single locks keep the legacy `uuid` field.
 *
 * @param {string} uuid - primary locked object (legacy field, always present).
 * @param {string} peerId - the peer holding the lock.
 * @param {string[]=} uuids - full selection set when the peer multi-selects.
 */
export function lockGeometry(uuid, peerId, uuids) {
    const wanted = (uuids && uuids.length ? uuids : [uuid]).filter((/** @type {any} */ entry) =>
        sceneObjects.getObjectByProperty('uuid', entry)
    );
    if (!wanted.length) return;
    // one lock SET per peer: drop the peer's previous locks, add the new ones
    locked = locked.filter((/** @type {any} */ lockedUuid) => lockedUuid[0] != peerId);
    wanted.forEach((/** @type {any} */ entry) => locked.push([peerId, entry]));
    lockedObjects.set(locked);
}
