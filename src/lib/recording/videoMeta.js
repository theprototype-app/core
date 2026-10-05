// 36-share (B13) — how long a video file is and how big its picture is, read by a detached
// <video> (the browser's own demuxer; the AudioPlayer reasoning — an element knows its duration
// without decoding the file). A webm with no Duration reports Infinity until it is seeked to the
// end, so that case seeks once before answering. Resolves null on anything unplayable or after 5 s.

/** @param {Blob} blob @returns {Promise<{duration: number, width: number, height: number} | null>} */
export function videoMeta(blob) {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(blob);
		const v = document.createElement('video');
		v.preload = 'metadata';
		v.muted = true;
		let done = false;
		/** @param {{duration: number, width: number, height: number} | null} value */
		const end = (value) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			v.removeAttribute('src');
			v.load();
			URL.revokeObjectURL(url);
			resolve(value);
		};
		const timer = setTimeout(() => end(null), 5000);
		const answer = () => end({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
		v.onloadedmetadata = () => {
			if (Number.isFinite(v.duration)) return answer();
			v.ondurationchange = () => Number.isFinite(v.duration) && answer();
			v.currentTime = 1e9;
		};
		v.onerror = () => end(null);
		v.src = url;
	});
}
