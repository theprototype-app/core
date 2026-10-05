// @ts-nocheck
// vendored from vhacd-js@0.0.1 (BSD-3-Clause, see LICENSE; github.com/pmconne/v-hacd-js) — 36 X3
import instantiateModule from "./vhacd-wasm.js";
import { VHACD } from "./vhacd-wasm-api.js";
export var ConvexMeshDecomposition;
(function (ConvexMeshDecomposition) {
    let vhacd;
    /** Create a ConvexMeshDecomposition. */
    async function create() {
        if (!vhacd)
            vhacd = await instantiateModule();
        return {
            computeConvexHulls: (mesh, options) => computeConvexHulls(vhacd, mesh, options),
        };
    }
    ConvexMeshDecomposition.create = create;
})(ConvexMeshDecomposition || (ConvexMeshDecomposition = {}));
function populateParameters(params, opts) {
    const numericKeys = ["maxHulls", "voxelResolution", "minVolumePercentError", "maxRecursionDepth", "maxVerticesPerHull", "minEdgeLength"];
    for (const key of numericKeys) {
        const opt = opts[key];
        if (undefined !== opt)
            params[key] = opt;
    }
    if (undefined !== opts.shrinkWrap)
        params.shrinkWrap = opts.shrinkWrap;
    if (undefined !== opts.findBestPlane)
        params.findBestPlane = opts.findBestPlane;
    switch (opts.fillMode) {
        case "flood":
            params.fillMode = VHACD.FillMode.Flood;
            break;
        case "surface":
            params.fillMode = VHACD.FillMode.Surface;
            break;
        case "raycast":
            params.fillMode = VHACD.FillMode.Raycast;
            break;
    }
}
function computeConvexHulls(vhacd, mesh, opts) {
    if (mesh.positions.length < 9 || mesh.indices.length < 3)
        return [];
    if (mesh.positions.length % 3 !== 0)
        throw new Error("3 coordinates required per vertex");
    if (mesh.indices.length % 3 !== 0)
        throw new Error("Triangles required.");
    const params = new vhacd.Parameters();
    if (opts)
        populateParameters(params, opts);
    let messages = VHACD.MessageType.None;
    switch (opts === null || opts === void 0 ? void 0 : opts.messages) {
        case "all":
            messages = VHACD.MessageType.All;
            break;
        case "log":
            messages = VHACD.MessageType.Log;
            break;
        case "progress":
            messages = VHACD.MessageType.Progress;
            break;
    }
    let pPoints = 0;
    let pTriangles = 0;
    let decomposer;
    try {
        // Allocate everything first, in case memory grows.
        pPoints = vhacd._malloc(8 * mesh.positions.length);
        pTriangles = vhacd._malloc(4 * mesh.indices.length);
        // Initialize memory.
        vhacd.HEAPF64.set(mesh.positions, pPoints / 8);
        vhacd.HEAPU32.set(mesh.indices, pTriangles / 4);
        decomposer = new vhacd.MeshDecomposer(params, messages);
        const hulls = decomposer.compute(pPoints, mesh.positions.length / 3, pTriangles, mesh.indices.length / 3);
        const meshes = [];
        const nHulls = hulls.size();
        for (let i = 0; i < nHulls; i++) {
            const hull = hulls.get(i);
            const pts = hull.getPoints() / 8;
            const tris = hull.getTriangles() / 4;
            const mesh = {
                positions: vhacd.HEAPF64.slice(pts, pts + hull.numPoints * 3),
                indices: vhacd.HEAPU32.slice(tris, tris + hull.numTriangles * 3),
            };
            // console.log({ positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) });
            meshes.push(mesh);
        }
        return meshes;
    }
    finally {
        vhacd._free(pPoints);
        vhacd._free(pTriangles);
        decomposer === null || decomposer === void 0 ? void 0 : decomposer.dispose();
    }
}
