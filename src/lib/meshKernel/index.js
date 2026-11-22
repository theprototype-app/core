// Roadmap 99 K1: the headless mesh kernel. Nothing in the app imports it yet (K2-K4 do).
// `three.js` (kernel -> BufferGeometry) is deliberately NOT re-exported here, so this entry stays
// three-free for Workers; import it directly where a geometry is wanted.
export { MeshKernel, NONE, MAX_VERTICES } from './kernel.js';
export { SpatialHash } from './spatialHash.js';
export { triangulatePolygon } from './triangulate.js';
export { fromArrays, toArrays } from './arrays.js';
export { fromBufferGeometry, geometryArrays, plainAttribute, storedPartition } from './geometry.js';
export { kernelToFaceWire, faceWireToPartition, toMeshGeo, fromMeshGeo } from './topo.js';
