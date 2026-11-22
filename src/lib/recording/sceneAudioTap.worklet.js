// 102b-sound — the moment buffer's audio tap, on the audio thread. It copies what reaches its input
// (the scene's own mix, never voices or a microphone: sceneAudio.js wires it) into blocks of BLOCK
// frames and posts each block with the context time of its first frame. Self-contained: a worklet
// module is loaded as is, with no imports.
const BLOCK = 2048;

class SceneAudioTap extends AudioWorkletProcessor {
	constructor() {
		super();
		/** @type {Float32Array[]} */
		this.buf = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
		this.fill = 0;
		this.start = 0;
	}

	/** @param {Float32Array[][]} inputs */
	process(inputs) {
		const input = inputs[0];
		const n = input && input[0] ? input[0].length : 128;
		if (this.fill === 0) this.start = currentFrame;
		for (let c = 0; c < 2; c++) {
			// mono in = both channels the same; no input (nothing connected yet) = silence
			const src = input && (input[c] || input[0]);
			if (src) this.buf[c].set(src, this.fill);
			else this.buf[c].fill(0, this.fill, this.fill + n);
		}
		this.fill += n;
		if (this.fill >= BLOCK) {
			const out = this.buf;
			this.port.postMessage({ frame: this.start, rate: sampleRate, l: out[0], r: out[1] }, [out[0].buffer, out[1].buffer]);
			this.buf = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
			this.fill = 0;
		}
		return true;
	}
}

registerProcessor('tp-scene-audio-tap', SceneAudioTap);
