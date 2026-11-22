# Mesh kernel API (roadmap 99 K1)

`src/lib/meshKernel/` is a headless mesh: pure JS, no three.js in the core, so it runs in node, in a
Worker and in the page. Nothing in the app imports it yet. K2-K4 move the editor onto it.

| file | what | imports |
|---|---|---|
| `kernel.js` | `MeshKernel`: storage, adjacency, queries, edits, validate, compact, transfer | triangulate, spatialHash |
| `triangulate.js` | `triangulatePolygon(coords, n)`: ear clipping, output only | none |
| `spatialHash.js` | `SpatialHash`: uniform grid, CSR-packed, neighbour-cell queries | none |
| `arrays.js` | `fromArrays` / `toArrays`: the lossless import and output | kernel, spatialHash |
| `geometry.js` | `fromBufferGeometry` (reads a geometry by duck type) | arrays |
| `three.js` | `toBufferGeometry` (the only file that imports three) | three, arrays |
| `topo.js` | CSR face packing + `meshgeo` payload, with optional ID channels | meshTopology, arrays |
| `index.js` | everything except `three.js` | |

## Model
Flat typed arrays: BMesh's model, flattened (owner fork 2a).
- **Vertex** `v`: `vPos` (Float64 x3), `vEdge` (the first edge of its *disk*, the cycle of edges around it).
- **Edge** `e`: `eVert` (2 vertices), `eDisk` (the next edge around each end), `eCorner` (the first corner of its *radial* cycle, one corner per face side on the edge; 0 = wire, 1 = boundary, 2 = manifold, more = non-manifold).
- **Face** `f`: an n-gon, a contiguous block of corners `fFirst..fFirst+fLen-1` in winding order, plus `fMat` (material slot; -1 = no group draws it).
- **Corner** `c` (a face-vertex, BMesh's "loop"): `cVert`, `cEdge` (to the next corner), `cFace`, `cRadial`, and every per-corner attribute in `mesh.attrs[name] = { size, data }` (uv, normal, color, uv1, tangent, anything).
- **IDs are slots and are never reused until `compact()`.** An edit keeps the ID of everything it does not delete. Corner indices are not IDs (a face's block moves when it is rebuilt).
- **Triangles are output only.** Each face keeps a triangulation cache (local corner triples + an order key per triangle). An imported face keeps its source triangles and their order; a vertex move keeps the diagonals; a topology edit marks the face dirty and output re-triangulates it (ear clipping).
- **Degenerate faces** (two consecutive corners on one vertex, e.g. a welded sliver): kept for output with their corners and attributes, never linked into edges, so no query sees them.

## Build and read
```js
const m = new MeshKernel({ attributes: { uv: 2 } });
const a = m.addVertex(0, 0, 0);            // -> vertex ID
const f = m.addFace([a, b, c, d], { material: 0, attrs: { uv: [/* n*2 */] } });
const e = m.addEdge(a, b);                 // a wire edge, or the existing one
m.findEdge(a, b)                           // walks a's disk: no hash table
m.faceVertices(f) m.faceEdges(f) m.faceCorners(f) m.faceSize(f) m.faceNeighbors(f) m.faceNormal(f) m.faceCenter(f)
m.edgeVertices(e) m.edgeFaces(e) m.edgeCorners(e) m.edgeValence(e) m.otherVertex(e, v)
m.vertexEdges(v) m.vertexFaces(v) m.vertexCorners(v) m.vertexNeighbors(v) m.position(v) m.setPosition(v, x, y, z)
m.cornerNext(c) m.cornerPrev(c) m.cornerAttribute(c, 'uv') m.setCornerAttribute(c, 'uv', [u, v])
m.vertexIds() m.edgeIds() m.faceIds({ degenerate }) m.hasVertex(v) m.hasEdge(e) m.hasFace(f)
m.stats() m.eulerCharacteristic() m.topologyReport() m.faceComponents() m.boundaryLoops() m.validate()
```
`topologyReport()` = `{euler, boundaryEdges, nonManifoldEdges, wireEdges, windingConflicts, isolatedVertices, nonManifoldVertices, components, boundaryLoops, closed, manifold, orientable}`. `validate()` returns a list of broken invariants (empty = consistent); it is the property tests' oracle, O(mesh), not for hot paths.

## Edit (the K4 building blocks; each keeps every untouched ID)
| call | does | IDs |
|---|---|---|
| `splitEdge(e, t)` | new vertex at t on e; every face on e gains a corner, attrs lerped per face | e keeps the half at its first vertex; returns `{vertex, edge}` |
| `splitFace(f, va, vb)` | new edge va-vb | f keeps va..vb; returns `{face, edge}` |
| `dissolveEdge(e)` | joins the two faces on a manifold edge into one n-gon, keeping both triangulations | lower face ID survives; NONE on a seam, open edge, mixed material, or a repeat |
| `mergeVertices(keep, drop)` | drop's faces use keep; collapsed sides and < 3-corner faces go | drop's edges move onto keep unless keep already has that edge |
| `collapseEdge(e, t)` | moves the first vertex to t, merges the second into it | first vertex survives |
| `flipFace(f)` | reverses winding; mirrors its triangulation | unchanged |
| `removeFace(f, {keepEdges})` / `removeEdge(e)` / `removeVertex(v)` | delete with their dependants | |
| `weldByDistance(eps)` | merges vertices within eps through the spatial hash (pairs across a cell wall too) | lowest ID of a cluster survives, with its position |
| `compact()` | renumbers densely | returns `{vertices, edges, faces}` old -> new maps (NONE = gone) |

## Geometry in and out
```js
const { mesh, report } = fromBufferGeometry(geometry, { weld: 0 });   // 0 exact (default), eps > 0, false = none
const { geometry, arrays } = toBufferGeometry(mesh, { topo: 'auto', computeNormals: false });   // three.js
const out = toArrays(mesh);   // { positions, attributes, groups, material, triFace, cornerVertex, faces }
```
- Import welds by **exact numeric equality** (-0 meets 0), so nothing moves and the round trip is lossless; `weld: 1e-4` is the editor's `keyOf` tolerance (positions snap to the lowest-index point of a cluster).
- Every attribute except position becomes a corner attribute; interleaved / normalized storage is read through the accessors and comes out Float32. Morph attributes are reported in `report.dropped`.
- A stored partition (`userData.__topo`) turns each stored face into one n-gon when its triangles form a clean disk with one value per attribute at each corner; otherwise that face stays triangles (`report.fallbackFaces`). `report` = `{triangles, faces, ngons, degenerate, fallbackFaces, partition: used|absent|invalid|ids, vertices, dropped}`.
- Output is non-indexed (what the editor commits today): triangles in source order, then new ones; groups are runs of one slot; `faces` is the `__topo` partition over output triangles; `cornerVertex` / `triFace` are the vertex ID per output corner and the face ID per output triangle.

## Wire (no new message, no new format)
- `kernelToFaceWire(mesh)` -> `{faceCounts, faceTris}`: meshTopology's CSR raw bytes. `faceWireToPartition(counts, tris, triCount)` validates the other way.
- `toMeshGeo(mesh, { ids })` -> `{positions, groups, uvs, colors, faceCounts?, faceTris?, ids?}`, the `meshgeo` fields with faceEdit's null-when-trivial rules. `fromMeshGeo(msg)` rebuilds; with `ids` (`cornerVertex` + `triFace` Int32 raw bytes) the receiver gets the SENDER's vertex and face IDs (no welding). Edge IDs are re-derived (store an edge selection as its vertex-ID pair).
- `mesh.toTransfer()` / `MeshKernel.transferList(packed)` / `MeshKernel.fromTransfer(packed)`: the whole kernel as trimmed typed arrays for a Worker. `byteSize()` = `{allocated, used}`, `trim()` shrinks to used.

## Spatial hash
`new SpatialHash(positions, { cellSize, count, include })`, `query(x, y, z, r, visit)` (each point within r once, `return false` stops), `within(...)`, `clusters(eps)` (union-find to the lowest index). `mesh.spatialHash(cellSize)` builds one over the live vertices (rebuild after moves).

## Limits
- 2^26 vertices (the import's pair keys). Float64 positions in the kernel, Float32 out.
- A material slot is per FACE (an n-gon is one draw group); the source's per-triangle slot round-trips because a stored face with mixed slots stays triangles.
- A cached triangulation is kept across vertex moves; a move that folds a concave n-gon can make it overlap until the next topology edit (K5: re-triangulate dirty-by-move faces on commit).
