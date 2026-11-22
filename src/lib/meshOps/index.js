// Roadmap 99 K4: the mesh operators on the kernel — a LAZY chunk (faceEdit sits in both boot graphs,
// so it reaches this only through `session.ops`, loaded when an edit session opens). Pattern page:
// ~/.code/lanes-30/after-99/99-ops-a/PATTERN.md.
export {
	OP_WELD,
	buildView,
	opMeshFromArrays,
	opOutput,
	opPartition,
	opTriangles,
	idChannels,
	isolateTriangles,
	cloneOpMesh,
	authoredFaces,
	beginOp
} from './opMesh.js';
export {
	extrudeRegion,
	insetRegion,
	moveRegion,
	extrudeIndividual,
	insetExtended,
	regionHasBorder,
	averagedNormal,
	triangleComponents
} from './extrude.js';
export { plainAttribute } from '../meshKernel/geometry.js';
export { fromSoup, toSoup, opMeshFromGeometry } from './soup.js';
export { insetFraction, bevelRegion, bevelVertices, bevelEdges } from './bevel.js';
