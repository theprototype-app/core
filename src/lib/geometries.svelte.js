import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { toggleExpand, fixLight } from '../stores/appStore.js';
import { customGeometryBuilders } from '$lib/customGeometries';
import { stampGeometryParams } from '$lib/geometryEdit';
import { paletteColorFor } from '$lib/palette';

// RectAreaLight renders black on Standard/Physical materials until the
// uniforms lib initializes — once per session is enough (79)
let rectAreaReady = false;
function initRectAreaUniforms() {
    if (rectAreaReady) return;
    rectAreaReady = true;
    RectAreaLightUniformsLib.init();
}
import { notifyExternalMove, noteObjectPose } from '$lib/flowRuntime';
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

// PFX-C follow-up: the primitives that spawn DYNAMIC by default (mass 1) so
// they fall/collide/throw the moment a sim runs. Terrain and module-registered
// kinds are intentionally absent (they stay scenery).
const FUN_PRIMITIVES = [
    'Box', 'Sphere', 'Cylinder', 'Cone', 'Capsule', 'Torus', 'TorusKnot', 'Ring',
    'Circle', 'Plane', 'Dodecahedron', 'Icosahedron', 'Octahedron', 'Tetrahedron',
    'Lathe', 'Tube', 'Wedge', 'Stairs', 'Arch', 'Corner'
];

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
        /** @type {any} */
        let mesh;
        if (customGeometryBuilders[geometry]) {
            // Custom builders (Stairs/Wedge/Arch/Corner/Terrain, + SDK ones) bake
            // post-construction rotateY/rotateX/translate into a PARAMETRIC geometry
            // (ExtrudeGeometry/PlaneGeometry). Their toJSON serializes only the shape +
            // options, so a SHARED (toJSON) copy rebuilds WITHOUT those transforms and
            // lands rotated/offset on peers (stairs looked rotated 90 deg). Bake into a
            // plain BufferGeometry whose toJSON carries the real vertices. The /create
            // path is deterministic regardless — this only matters for toJSON sharing.
            const built = customGeometryBuilders[geometry](options[0],options[1],options[2],options[3]);
            mesh = built?.type === 'BufferGeometry' ? built : new THREE.BufferGeometry().copy(built);
            if (built && built !== mesh) built.dispose?.();
        } else {
            mesh = new (/** @type {any} */ (THREE))[geometry+'Geometry'](options[0],options[1],options[2],options[3]);
        }
        let object = new THREE.Mesh(mesh, new THREE.MeshStandardMaterial({ roughness: 0.85 }));
        if (uuid) object.uuid = uuid
        // deterministic palette color keyed by the FINAL uuid (peers compute the
        // same color from the create message's uuid) — V-3, replaces 0x00ff00
        object.material.color.set(paletteColorFor(object.uuid));
        object.name = geometry;
        if (geometry === 'Terrain') {
            // terrain gets a distinct sage look + a flag the Sculpt menu keys off
            // (deterministic on both peers; survives toJSON + GLTF extras) — T-1
            object.material.color.set('#81b29a');
            object.material.roughness = 0.95;
            object.userData.terrain = true;
        }
        // PFX-C follow-up: standard primitives are DYNAMIC by default (mass 1) so
        // a fresh cube falls, collides and THROWS the moment a sim runs — fun by
        // default. Explicit allow-list: Terrain + module-registered primitives
        // (buttons, playables) stay scenery. Deterministic — receivers run this
        // same builder from the replicated /create, and the stamp rides
        // userData.physics like an Inspector edit (Body: Auto reverts it).
        if (FUN_PRIMITIVES.includes(geometry)) object.userData.physics = { mode: 'dynamic', mass: 1 };
        stampGeometryParams(object); // editable params survive sync (78)
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
    } else if (lightType == 'rectarea') {
        // needs the uniforms lib once, or Standard/Physical materials render black
        initRectAreaUniforms();
        light = new THREE.RectAreaLight(0xffffff, 2, 4, 4);
        light.name = 'RectArea';
    } else {
        console.log('Invalid light: ' + light);
        return null
    }       
    if (light){
        fixLight.set(false);
        // Directional/Spot cast shadows by default (V-1); Point stays opt-in
        // (6-face cube-map cost). Deterministic: the same /light command runs
        // on every peer, so shadow flags match without extra sync.
        if (light.isDirectionalLight || light.isSpotLight) {
            light.castShadow = true;
            if (light.isDirectionalLight && light.shadow) {
                light.shadow.camera.left = -15;
                light.shadow.camera.right = 15;
                light.shadow.camera.top = 15;
                light.shadow.camera.bottom = -15;
                light.shadow.camera.far = 80;
                light.shadow.camera.updateProjectionMatrix();
            }
            if (light.shadow) {
                light.shadow.bias = -0.0002;
                light.shadow.normalBias = 0.02;
            }
        }
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
        // CL-C C3: ~10Hz speed approximation feed on peers (velocity node)
        noteObjectPose(uuid, pos[0], pos[1], pos[2]);
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
