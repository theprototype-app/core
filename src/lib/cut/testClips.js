// 77 — TEST CLIPS: a WebM made in the page, frame by frame, with Mediabunny's encoder — solid
// colour segments, so a suite can say "at 1.5 s the frame is green" and mean the exact frame.
// Reached only through the debug hook (`__stores.cutTestClips`); nothing in the app imports it.

/**
 * @param {{colors?: string[], segment?: number, fps?: number, width?: number, height?: number}} [opts]
 * @returns {Promise<Blob>} a video/webm of colors.length × segment seconds
 */
export async function makeTestClip(opts = {}) {
	const { colors = ['#ff0000', '#00ff00', '#0000ff'], segment = 1, fps = 30, width = 320, height = 180 } = opts;
	const mb = await import('mediabunny');
	const codec = (await mb.canEncodeVideo('vp9', { width, height })) ? 'vp9' : 'vp8';
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
	const target = new mb.BufferTarget();
	const output = new mb.Output({ format: new mb.WebMOutputFormat(), target });
	const source = new mb.CanvasSource(canvas, { codec, bitrate: 2e6, keyFrameInterval: 1 });
	output.addVideoTrack(source, { frameRate: fps });
	await output.start();
	const per = Math.round(segment * fps);
	for (let i = 0; i < colors.length * per; i++) {
		ctx.fillStyle = colors[Math.floor(i / per)];
		ctx.fillRect(0, 0, width, height);
		await source.add(i / fps, 1 / fps);
	}
	await output.finalize();
	return new Blob([/** @type {ArrayBuffer} */ (target.buffer)], { type: 'video/webm' });
}
