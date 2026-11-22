<script>
	// fix-play-link — THE HIDDEN XR BUTTONS ON THE PLAY PAGE. `playMode.requestPlay` enters a headset
	// session by CLICKING threlte's own (hidden) VRButton / XRButton inside the player's gesture; the
	// editor mounts them in Controls.svelte (the twin of this block — keep the two alike), and the play
	// entry (PlayApp.svelte) mounted no Controls, so the start card's Enter VR found no button and fell
	// through to FLAT play: Enter VR on a play link never opened a session. Same ids, same session init.
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
