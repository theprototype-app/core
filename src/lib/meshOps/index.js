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
export { loopCutRegion, connectVerticesRegion } from './cut.js';
export { knifeCut } from './knife.js';
export { cellMap } from './rebuild.js';
// 99-ops-b family 4
export { bridgeRegions, fillHole, solidifyRegion, boundaryLoopOf, edgesOfKeys, keyOfPos } from './bridgeFill.js';
// 99-ops-b family 5
export {
	verticesOfKeys,
	trianglesTouching,
	trianglesOnSides,
	deleteTriangles,
	mergeByDistance,
	dissolveEdges,
	dissolveVertices
} from './dissolve.js';
// 99-ops-b family 6
export { subdivideUnits, subdivideLevels, subdivideEdges, symmetrize } from './subdivide.js';
