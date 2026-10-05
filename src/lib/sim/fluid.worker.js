// 36-sim U2b: the fluid tank's Web Worker — runs fluidCore's PBF solver off the main
// thread. One worker serves every tank (tanks are few; a worker each would multiply the
// memory). Protocol (all plain data, positions transferred, never copied twice):
//   {op:'init', id, min, max, capacity, spacing, fill, count}
//   {op:'step', id, dt, gravity, viscosity, surfaceTension, colliders, spec, buffer?,
//        walls? (36-fb: 6 booleans), lifetime? (s), spawn? [x,y,z,vx,vy,vz]*, sinks? [{min,max}],
//        shift? [dx,dy,dz], flows? CompiledFlow[] (36-fb F23/F24 emitters; spec null = no tank emitter/drain)}
//        -> {op:'frame', id, count, positions (transferred), impulses, ms, escaped? (transferred), sunk? [x,y,z]*}
//   {op:'drop', id}
import { FluidSolver, pourAndDrain } from './fluidCore.js';
import { spawnBatch, applySinks } from './fluidEmitterCore.js';
import { applyFlows } from './flowPathCore.js';

/** @type {Map<string, {solver: FluidSolver, gen: number, acc: {carry: number, drainCarry: number}}>} */
const tanks = new Map();

self.onmessage = (/** @type {MessageEvent} */ e) => {
	const m = e.data;
	if (m.op === 'init') {
		const solver = new FluidSolver({ min: m.min, max: m.max, capacity: m.capacity, spacing: m.spacing });
		solver.fillBlock(m.fill, m.count);
		if (m.walls) solver.setWalls(m.walls); // 36-fb F23: an emitter's open area
		tanks.set(m.id, { solver, gen: m.gen, acc: { carry: 0, drainCarry: 0 } });
		return;
	}
	if (m.op === 'drop') {
		tanks.delete(m.id);
		return;
	}
	if (m.op === 'step') {
		const tank = tanks.get(m.id);
		if (!tank) return;
		const t0 = performance.now();
		// 36-fb F23: an emitter moves its area (shift), sends its own new particles (spawn)
		// and has no tank spec; sinks swallow what reaches a pool
		if (m.shift) shiftAll(tank.solver, m.shift);
		// 36-fb S3: the scene budget's share — over it (the governor stepped down), the newest go
		if (typeof m.limit === 'number' && tank.solver.count > m.limit) tank.solver.count = Math.max(0, m.limit);
		spawnBatch(tank.solver, m.spawn);
		if (m.spec) pourAndDrain(tank.solver, m.spec, m.dt, tank.acc);
		tank.solver.step(m.dt, m);
		if (m.flows) applyFlows(tank.solver, m.flows, m.dt); // 36-fb F24: rivers steer, loops recycle, pipes pump
		const sunk = m.sinks ? applySinks(tank.solver, m.sinks) : null;
		const n = tank.solver.count;
		/** @type {Float32Array} */
		const out = m.buffer && m.buffer.byteLength >= n * 12 ? new Float32Array(m.buffer, 0, tank.solver.capacity * 3) : new Float32Array(tank.solver.capacity * 3);
		out.set(tank.solver.x.subarray(0, n * 3));
		// 36-fb: particles that left through a missing wall (opts.walls), transferred
		const escaped = tank.solver.escapedCount ? tank.solver.takeEscaped() : null;
		/** @type {any} */ (self).postMessage(
			{ op: 'frame', id: m.id, gen: tank.gen, count: n, positions: out, impulses: tank.solver.impulses, ms: performance.now() - t0, ...(escaped ? { escaped } : {}), ...(sunk?.length ? { sunk } : {}) },
			escaped ? [out.buffer, escaped.buffer] : [out.buffer]
		);
	}
};

/** the area moved by `d` (area-local): particles stay where they are in the world @param {any} s @param {number[]} d */
function shiftAll(s, d) {
	for (let i = 0; i < s.count * 3; i += 3) {
		s.x[i] -= d[0];
		s.x[i + 1] -= d[1];
		s.x[i + 2] -= d[2];
	}
}
