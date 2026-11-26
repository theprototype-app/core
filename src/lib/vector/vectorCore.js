// 64-vector: the CORE CHUNK the boot gate (vectorGate.js) loads on first need — the record's
// boundary, the Inspector rows and the mesh builder. Nothing here is on the boot path.
import { cleanVector, VECTOR_PARAMS } from './vectorRecord.js';
export { buildVectorGeometry } from './vectorMesh.js';
export { cleanVector, VECTOR_PARAMS };
/** the record's keys in Inspector order (GEOMETRY_PARAMS' `order`) */
export const VECTOR_ORDER = [...new Set(VECTOR_PARAMS.map((p) => p.key))];
