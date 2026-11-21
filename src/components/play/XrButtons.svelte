<script>
	// fix-play-link — THE HIDDEN XR BUTTONS. `playMode.requestPlay` enters a headset session by CLICKING threlte's own
	// (hidden) VRButton / XRButton inside the player's gesture. The play entry (PlayApp.svelte) mounted no Controls, so
	// the start card's Enter VR found no button and fell through to FLAT play.
	// 80a-fix4-ui G9: this is the ONE copy — the editor's Controls.svelte mounts it too (it had its own twin, kept alike
	// by hand). Both buttons mount permanently (4a, the note in Controls.svelte): same ids, same session init.
	import { VRButton, XRButton } from '@threlte/xr';
	import { vrPassthrough } from '../../stores/sceneStore';
	import { xrSessionFailed } from '$lib/playMode';
</script>

<div class="hidden" id="vrButton" data-aim={$vrPassthrough ? 'ar' : 'vr'}>
	<div id="vrButtonVr"><VRButton onerror={() => xrSessionFailed()} /></div>
	<div id="vrButtonAr">
		<XRButton
			mode="immersive-ar"
			onerror={() => xrSessionFailed()}
			sessionInit={{
				requiredFeatures: [],
				optionalFeatures: ['local-floor', 'bounded-floor', 'anchors', 'hand-tracking', 'plane-detection', 'layers', 'depth-sorted-layers', 'hit-test', 'mesh-detection']
			}}
		/>
	</div>
</div>
