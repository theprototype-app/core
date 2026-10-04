// 36-sim U2b: the fluid tank's Web Worker — runs fluidCore's PBF solver off the main
// thread. One worker serves every tank (tanks are few; a worker each would multiply the
// memory). Protocol (all plain data, positions transferred, never copied twice):
//   {op:'init', id, min, max, capacity, spacing, fill, count}
//   {op:'step', id, dt, gravity, viscosity, surfaceTension, colliders, spec, buffer?}
//        -> {op:'frame', id, count, positions (transferred), impulses, ms}
//   {op:'drop', id}
import { FluidSolver, pourAndDrain } from './fluidCore.js';

/** @type {Map<string, {solver: FluidSolver, acc: {carry: number, drainCarry: number}}>} */
const tanks = new Map();

self.onmessage = (/** @type {MessageEvent} */ e) => {
	const m = e.data;
	if (m.op === 'init') {
		const solver = new FluidSolver({ min: m.min, max: m.max, capacity: m.capacity, spacing: m.spacing });
		solver.fillBlock(m.fill, m.count);
		tanks.set(m.id, { solver, acc: { carry: 0, drainCarry: 0 } });
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
		pourAndDrain(tank.solver, m.spec, m.dt, tank.acc);
		tank.solver.step(m.dt, m);
		const n = tank.solver.count;
		/** @type {Float32Array} */
		const out = m.buffer && m.buffer.byteLength >= n * 12 ? new Float32Array(m.buffer, 0, tank.solver.capacity * 3) : new Float32Array(tank.solver.capacity * 3);
		out.set(tank.solver.x.subarray(0, n * 3));
		/** @type {any} */ (self).postMessage(
			{ op: 'frame', id: m.id, count: n, positions: out, impulses: tank.solver.impulses, ms: performance.now() - t0 },
			[out.buffer]
		);
	}
};
