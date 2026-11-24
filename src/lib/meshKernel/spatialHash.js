// Roadmap 99 K1: a uniform-grid spatial hash over points, CSR-packed in typed arrays.
//
// Built once over a position array (O(n), two passes); a query visits only the cells its radius
// touches, so "everything within r of p" costs the neighbourhood, not the mesh. This is what the
// sculpt brush (K6) and merge-by-distance need: today's sculpt scans every vertex per dab, and
// today's mergeByDistance quantises to ONE cell per point, so two points 1e-6 apart on either
// side of a cell wall never merge. Here a query always checks the neighbouring cells.
//
// Buckets are hashed (not a dense 3D grid), so the memory is O(points) whatever the extent; a
// bucket can hold points of several cells, and the distance test filters them.

const P1 = 73856093;
const P2 = 19349663;
const P3 = 83492791;
/** windows up to this many cells dedupe buckets without allocating */
const SCRATCH = 64;

export class SpatialHash {
	/**
	 * @param {ArrayLike<number>} positions x,y,z per point
	 * @param {{ cellSize: number, count?: number, include?: (i: number) => boolean }} options
	 *   `count` points (default positions.length / 3); `include` skips points (dead vertices)
	 */
	constructor(positions, options) {
		const cell = options.cellSize;
		if (!(cell > 0)) throw new Error('spatial hash: cellSize must be > 0');
		const count = options.count ?? Math.floor(positions.length / 3);
		this.positions = positions;
		/** points indexed (included or not) */
		this.size = count;
		this.cellSize = cell;
		this.inv = 1 / cell;
		let size = 1;
		while (size < count * 2) size <<= 1;
		this.mask = size - 1;
		const bucketOf = new Int32Array(count).fill(-1);
		const starts = new Int32Array(size + 1);
		for (let i = 0; i < count; i++) {
			if (options.include && !options.include(i)) continue;
			const b = this._bucket(
				Math.floor(positions[i * 3] * this.inv),
				Math.floor(positions[i * 3 + 1] * this.inv),
				Math.floor(positions[i * 3 + 2] * this.inv)
			);
			bucketOf[i] = b;
			starts[b + 1]++;
		}
		for (let b = 0; b < size; b++) starts[b + 1] += starts[b];
		const items = new Int32Array(starts[size]);
		const fill = starts.slice(0, size);
		for (let i = 0; i < count; i++) if (bucketOf[i] >= 0) items[fill[bucketOf[i]]++] = i;
		this.starts = starts;
		this.items = items;
		this.count = items.length;
		this._scratch = new Int32Array(SCRATCH);
	}

	/** @param {number} ix @param {number} iy @param {number} iz */
	_bucket(ix, iy, iz) {
		return (Math.imul(ix, P1) ^ Math.imul(iy, P2) ^ Math.imul(iz, P3)) & this.mask;
	}

	/**
	 * Visit every point within `radius` of (x, y, z) (inclusive), each once, with its squared
	 * distance. Return `false` from the callback to stop early.
	 * @param {number} x @param {number} y @param {number} z @param {number} radius
	 * @param {(index: number, distSq: number) => (boolean|void)} visit
	 */
	query(x, y, z, radius, visit) {
		const p = this.positions;
		const r2 = radius * radius;
		const x0 = Math.floor((x - radius) * this.inv);
		const x1 = Math.floor((x + radius) * this.inv);
		const y0 = Math.floor((y - radius) * this.inv);
		const y1 = Math.floor((y + radius) * this.inv);
		const z0 = Math.floor((z - radius) * this.inv);
		const z1 = Math.floor((z + radius) * this.inv);
		// one bucket can be reached from two cells of the window: visit each bucket once (a small
		// window dedupes in a scratch array, a big one in a Set)
		const cells = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
		/** @type {Set<number>|null} */
		const seen = cells > SCRATCH ? new Set() : null;
		const scratch = this._scratch;
		let used = 0;
		for (let ix = x0; ix <= x1; ix++)
			for (let iy = y0; iy <= y1; iy++)
				for (let iz = z0; iz <= z1; iz++) {
					const b = this._bucket(ix, iy, iz);
					if (seen) {
						if (seen.has(b)) continue;
						seen.add(b);
					} else if (cells > 1) {
						let dup = false;
						for (let k = 0; k < used; k++)
							if (scratch[k] === b) {
								dup = true;
								break;
							}
						if (dup) continue;
						scratch[used++] = b;
					}
					for (let k = this.starts[b]; k < this.starts[b + 1]; k++) {
						const i = this.items[k];
						const dx = p[i * 3] - x;
						const dy = p[i * 3 + 1] - y;
						const dz = p[i * 3 + 2] - z;
						const d2 = dx * dx + dy * dy + dz * dz;
						if (d2 <= r2 && visit(i, d2) === false) return;
					}
				}
	}

	/** indices within `radius` of a point @param {number} x @param {number} y @param {number} z @param {number} radius @returns {number[]} */
	within(x, y, z, radius) {
		/** @type {number[]} */
		const out = [];
		this.query(x, y, z, radius, (i) => {
			out.push(i);
		});
		return out;
	}

	/**
	 * Union points closer than `eps` (inclusive) into clusters. Returns each point's cluster
	 * representative = the LOWEST index in its cluster (deterministic); excluded points map to -1.
	 * Chains merge transitively (a~b, b~c => one cluster), the union-find semantics.
	 * @param {number} eps @returns {Int32Array}
	 */
	clusters(eps) {
		const n = this.size;
		const parent = new Int32Array(n).fill(-1);
		for (let k = 0; k < this.items.length; k++) parent[this.items[k]] = this.items[k];
		/** @param {number} a */
		const find = (a) => {
			while (parent[a] !== a) {
				parent[a] = parent[parent[a]];
				a = parent[a];
			}
			return a;
		};
		const p = this.positions;
		for (let k = 0; k < this.items.length; k++) {
			const i = this.items[k];
			this.query(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], eps, (j) => {
				if (j <= i) return;
				const a = find(i);
				const b = find(j);
				if (a === b) return;
				if (a < b) parent[b] = a;
				else parent[a] = b;
			});
		}
		for (let i = 0; i < n; i++) if (parent[i] >= 0) parent[i] = find(i);
		return parent;
	}
}
