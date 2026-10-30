// 73 AI3 — THE SANDBOXED FIRST COMPILE. A peer's GLSL meets a throwaway WebGL2 context on a
// 16x16 canvas in a worker before it ever reaches the scene's context: compile + link + one
// draw + a read that waits for it. A driver that takes its time here blocks this thread, not
// the app, and the main thread can terminate it.
import { PROBE_VERTEX_PREFIX, PROBE_FRAGMENT_PREFIX, stripAllowedIncludes, mapShaderLog } from './shaderCode.js';

const IDENTITY4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const IDENTITY3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** @param {any} gl @param {number} type @param {string} prefix @param {string} text @param {string} stage */
function compile(gl, type, prefix, text, stage) {
	const shader = gl.createShader(type);
	gl.shaderSource(shader, prefix + stripAllowedIncludes(text));
	gl.compileShader(shader);
	if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return { shader, errors: [] };
	return { shader: null, errors: mapShaderLog(gl.getShaderInfoLog(shader), prefix, stage) };
}

/** @param {any} data */
function probe(data) {
	if (typeof OffscreenCanvas === 'undefined') return { status: 'unavailable' };
	const canvas = new OffscreenCanvas(16, 16);
	/** @type {any} */
	const gl = canvas.getContext('webgl2');
	if (!gl) return { status: 'unavailable' };
	const v = compile(gl, gl.VERTEX_SHADER, PROBE_VERTEX_PREFIX, data.vertex, 'Vertex');
	const f = compile(gl, gl.FRAGMENT_SHADER, PROBE_FRAGMENT_PREFIX, data.fragment, 'Fragment');
	if (!v.shader || !f.shader) return { status: 'error', errors: [...v.errors, ...f.errors] };
	const program = gl.createProgram();
	gl.attachShader(program, v.shader);
	gl.attachShader(program, f.shader);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS))
		return { status: 'error', errors: ['Link: ' + String(gl.getProgramInfoLog(program)).replace(/\u0000/g, '').trim()] };
	gl.useProgram(program);
	// a triangle over the whole canvas, under identity matrices, so the fragment stage really runs
	const attribute = (/** @type {string} */ name, /** @type {number} */ size, /** @type {number[]} */ values) => {
		const at = gl.getAttribLocation(program, name);
		if (at < 0) return;
		gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.STATIC_DRAW);
		gl.enableVertexAttribArray(at);
		gl.vertexAttribPointer(at, size, gl.FLOAT, false, 0, 0);
	};
	attribute('position', 3, [-1, -1, 0, 3, -1, 0, -1, 3, 0]);
	attribute('normal', 3, [0, 0, 1, 0, 0, 1, 0, 0, 1]);
	attribute('uv', 2, [0, 0, 2, 0, 0, 2]);
	for (const name of ['modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix']) {
		const at = gl.getUniformLocation(program, name);
		if (at) gl.uniformMatrix4fv(at, false, IDENTITY4);
	}
	const normalAt = gl.getUniformLocation(program, 'normalMatrix');
	if (normalAt) gl.uniformMatrix3fv(normalAt, false, IDENTITY3);
	self.postMessage({ id: data.id, phase: 'draw' });
	const started = performance.now();
	gl.drawArrays(gl.TRIANGLES, 0, 3);
	gl.finish();
	gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
	const drawMs = performance.now() - started;
	if (gl.isContextLost()) return { status: 'lost' };
	// a browser keeps ~16 live contexts and sheds the OLDEST past that, which is the scene's:
	// never leave this one for the garbage collector to get round to
	gl.getExtension('WEBGL_lose_context')?.loseContext();
	return { status: 'ok', drawMs };
}

self.onmessage = (event) => {
	const { id } = event.data;
	self.postMessage({ id, phase: 'compile' });
	try {
		self.postMessage({ id, ...probe(event.data) });
	} catch (err) {
		self.postMessage({ id, status: 'unavailable', detail: String(err) });
	}
};
