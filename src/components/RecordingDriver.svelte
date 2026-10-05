<script>
	// 36-share (B13) — the recorder's two per-frame hooks, inside threlte's scheduler (the 15-H
	// rule: anything that must agree with a rendered frame may not own a requestAnimationFrame).
	//   pose    — after the main stage (OrbitControls has updated), before the render: the camera
	//             is where the recording wants it for THIS frame
	//   capture — after the render stage: the drawing buffer still holds the frame just drawn
	// Both are one null check while nothing records. It also hands the recorder threlte's own
	// pixel-ratio knob, so a 1080p recording from a small viewport is rendered sharp.
	import { onDestroy } from 'svelte';
	import { useStage, useTask, useThrelte } from '@threlte/core';
	import { registerRecordingDriver, recordingBeforeRender, recordingAfterRender } from '$lib/recording/recorder.js';

	const { mainStage, renderStage, dpr } = useThrelte();
	const poseStage = useStage('tp-recording-pose', { after: mainStage, before: renderStage });
	const captureStage = useStage('tp-recording-capture', { after: renderStage });
	useTask(recordingBeforeRender, { stage: poseStage, autoInvalidate: false });
	useTask(recordingAfterRender, { stage: captureStage, autoInvalidate: false });

	onDestroy(
		registerRecordingDriver({
			getDpr: () => dpr.current,
			setDpr: (v) => dpr.set(v)
		})
	);
</script>
