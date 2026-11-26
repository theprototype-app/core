// @ts-nocheck -- runs inside the WSL runner image / as a Playwright preload; Module._load and the probe page are untyped
'use strict';
// pc-ci-runner — THE GPU A WSL RUNNER ACTUALLY HAS, for Playwright launches (NODE_OPTIONS="--require <this file>").
//
// In WSL2 there is no Vulkan driver for the Windows GPU: `--use-angle=vulkan` (helpers.cjs GPU_ARGS on Linux) gets
// Mesa's llvmpipe, a CPU rasteriser, quietly. What WSL has is Mesa's d3d12 Gallium driver over /dev/dxg, reached
// through EGL: `--use-angle=gl-egl` with GALLIUM_DRIVER=d3d12 and the WSL driver folder on LD_LIBRARY_PATH (the
// runner's environment sets both). Measured renderer strings in such a distro:
//   (no GPU flags)                 ANGLE (Google, Vulkan 1.3.0 (SwiftShader ...))
//   --use-angle=vulkan             ANGLE (Mesa, Vulkan 1.4 (llvmpipe ...))
//   --use-angle=gl-egl + d3d12     ANGLE (Microsoft Corporation, D3D12 (<the card>), OpenGL ES 3.1)
// So a launch naming --use-angle=vulkan gets gl-egl instead, and with PW_GPU_ALL=1 a launch naming no GPU path gets
// it too (software WebGL is what makes a battery slow). A launch naming a path (--use-angle=, --use-gl=,
// --disable-gpu) keeps it. Active only when PW_WSL_GPU=1.
if (process.env.PW_WSL_GPU === '1' && !global.__tpciWslGpu) {
	global.__tpciWslGpu = true;
	const Module = require('module');
	const NAMES_GPU = /^--(use-angle|use-gl|disable-gpu)(=|$)/;
	const EGL = ['--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'];
	/** @param {string[] | undefined} args */
	const mapArgs = (args) => {
		const a = Array.isArray(args) ? args : [];
		if (process.env.PW_GPU_ALL === '1' && !a.some((x) => NAMES_GPU.test(x))) return [...a, ...EGL];
		if (!a.includes('--use-angle=vulkan')) return args;
		return a.flatMap((x) => {
			if (x === '--use-angle=vulkan') return ['--use-angle=gl-egl'];
			if (x.startsWith('--enable-features=')) {
				const rest = x.slice(18).split(',').filter((f) => f && f !== 'Vulkan');
				return rest.length ? ['--enable-features=' + rest.join(',')] : [];
			}
			return [x];
		});
	};
	/** @param {any} chromium */
	const patch = (chromium) => {
		if (!chromium || chromium.__tpciWslGpu || typeof chromium.launch !== 'function') return;
		chromium.__tpciWslGpu = true;
		for (const name of ['launch', 'launchPersistentContext', 'launchServer']) {
			const real = chromium[name];
			if (typeof real !== 'function') continue;
			const at = name === 'launchPersistentContext' ? 1 : 0;
			chromium[name] = function (/** @type {any[]} */ ...a) {
				const o = a[at] || {};
				if (typeof o === 'object') a[at] = { ...o, args: mapArgs(o.args) };
				return real.apply(this, a);
			};
		}
	};
	// @ts-ignore -- Module._load is internal
	const realLoad = Module._load;
	// @ts-ignore
	Module._load = function (/** @type {string} */ request, /** @type {any[]} */ ...rest) {
		const exp = realLoad.call(this, request, ...rest);
		if (typeof request === 'string' && request.includes('playwright')) {
			try {
				patch(exp && exp.chromium);
			} catch {
				/* leave it as it was */
			}
		}
		return exp;
	};
}
