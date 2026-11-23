// @ts-nocheck — bench runner (node). Writes the table to BENCH_OUT (default: stdout only).
// BENCH_SIZES=10k,67k  BENCH_TODAY_MAX=100k  narrow it.
import { it } from 'vitest';
import fs from 'fs';
import os from 'os';
import { runBench, benchTable } from './meshKernelBench.js';

it('mesh kernel bench (node)', async () => {
	const sizes = process.env.BENCH_SIZES?.split(',');
	const rows = await runBench({ sizes, todayMax: process.env.BENCH_TODAY_MAX ?? '1M', log: (s) => console.log(s) });
	const title = `node ${process.version}, ${os.cpus()[0]?.model ?? 'cpu'}, gc ${typeof globalThis.gc === 'function' ? 'exposed' : 'off'}`;
	const table = benchTable(rows, title);
	console.log(table);
	if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ title, rows }, null, 2) + '\n\n' + table + '\n');
});
