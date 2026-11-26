// @ts-nocheck -- runs inside the WSL runner image / as a Playwright preload; Module._load and the probe page are untyped
// pc-ci-runner — WHICH GPU DOES A JOB'S CHROMIUM GET? (start-job.sh --gpu, as the job user in the job namespace)
//
// Prints the WebGL renderer string and a rAF + draw-loop frame rate for two launches: Chromium's default
// (SwiftShader, what a GitHub-hosted runner draws with) and the WSL GPU path (ANGLE gl-egl over Mesa's d3d12
// Gallium driver on /dev/dxg — WSL has no Vulkan driver for a Windows GPU, so `--use-angle=vulkan` would quietly be
// llvmpipe). Optional: TPCI_SHOT_URL (+ TPCI_SHOT_CLICKS, TPCI_SHOT_WAIT) + TPCI_SHOT_OUT take one screenshot of a page on the GPU path.
'use strict';
const { chromium } = require(process.env.TPCI_PW || '/opt/tpci/gpu-probe/node_modules/playwright-core');

const GPU_ARGS = ['--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'];
const PAGE = `<canvas id=c width=1280 height=720></canvas><script>
const gl = document.getElementById('c').getContext('webgl2');
const ext = gl.getExtension('WEBGL_debug_renderer_info');
window.renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
const vs = '#version 300 es\\nin vec2 p; void main(){ gl_Position = vec4(p,0,1); }';
const fs = '#version 300 es\\nprecision highp float; uniform float t; out vec4 o; void main(){ vec2 u = gl_FragCoord.xy/vec2(1280,720); float a = 0.; for (int i = 0; i < 64; i++) a += sin(u.x*float(i)+t)*cos(u.y*float(i)-t); o = vec4(vec3(a*.05+.5),1); }';
function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr); gl.useProgram(pr);
const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
const ut = gl.getUniformLocation(pr, 't');
window.frames = 0;
(function loop(t) { gl.uniform1f(ut, t / 1000); gl.drawArrays(gl.TRIANGLES, 0, 3); window.frames++; requestAnimationFrame(loop); })(0);
</script>`;

async function probe(label, args) {
	const browser = await chromium.launch({ args });
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
		await page.setContent(PAGE);
		await page.waitForTimeout(1000);
		const f0 = await page.evaluate(() => window.frames);
		await page.waitForTimeout(3000);
		const f1 = await page.evaluate(() => window.frames);
		const renderer = await page.evaluate(() => window.renderer);
		console.log(`${label}: renderer="${renderer}" fps=${((f1 - f0) / 3).toFixed(1)}`);
		if (label === 'gpu' && process.env.TPCI_SHOT_URL && process.env.TPCI_SHOT_OUT) {
			const p2 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
			if (process.env.TPCI_SHOT_INIT) await p2.addInitScript(process.env.TPCI_SHOT_INIT);
			await p2.goto(process.env.TPCI_SHOT_URL, { waitUntil: 'load', timeout: 120000 });
			// TPCI_SHOT_CLICKS="text|text": click these visible texts in order (e.g. a template picker)
			for (const t of (process.env.TPCI_SHOT_CLICKS || '').split('|').filter(Boolean)) {
				await p2.getByText(t, { exact: true }).first().click({ timeout: 60000 });
				await p2.waitForTimeout(1500);
			}
			await p2.waitForTimeout(Number(process.env.TPCI_SHOT_WAIT || 15000));
			await p2.screenshot({ path: process.env.TPCI_SHOT_OUT });
			console.log(`shot: ${process.env.TPCI_SHOT_OUT}`);
		}
	} finally {
		await browser.close();
	}
}

(async () => {
	await probe('software', []);
	await probe('gpu', GPU_ARGS);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
