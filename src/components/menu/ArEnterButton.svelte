<script>
	// CO4: an EXPLICIT "Enter AR" affordance beside the play button. The Settings
	// "Mixed reality" toggle already flips the NEXT play-button VR entry to
	// immersive-ar, but a user should not need Settings to find passthrough on a
	// device that has it — this button renders ONLY when the device reports
	// immersive-ar support (so desktop browsers never see it). Its own component
	// so it can use `onclick` without mixing with Controls.svelte's on:
	// directives (the MobileAddButton precedent).
	//
	// The session request goes through @threlte/xr's own toggleXRSession — the
	// SAME call the hidden XRButton makes — so threlte's <XR> plumbing (Scene's
	// onsessionstart passthrough derivation included) is shared, not duplicated,
	// and the persisted vrPassthrough preference is left untouched. The feature
	// list matches Controls' XRButton byte for byte.
	import { toggleXRSession } from '@threlte/xr';
	import { isVRMode } from '../../stores/sceneStore';
	import { showToast } from '../../stores/appStore';

	let arSupport = $state(false);
	if (typeof navigator !== 'undefined') {
		/** @type {any} */ (navigator).xr
			?.isSessionSupported?.('immersive-ar')
			.then((/** @type {boolean} */ ok) => (arSupport = !!ok))
			.catch(() => (arSupport = false));
	}

	async function enterAR() {
		$isVRMode = true; // the checkPlay VR-entry parity: mode first, session second
		try {
			await toggleXRSession(
				'immersive-ar',
				{
					requiredFeatures: [],
					optionalFeatures: ['local-floor', 'bounded-floor', 'anchors', 'hand-tracking', 'plane-detection', 'layers', 'depth-sorted-layers', 'hit-test', 'mesh-detection']
				},
				'enter'
			);
		} catch (err) {
			// Scene's onsessionend never fires for a session that never started —
			// put the editor back ourselves
			$isVRMode = false;
			showToast('Could not start AR: ' + String(/** @type {any} */ (err)?.message ?? err));
		}
	}
</script>

{#if arSupport}
	<!-- words, not a glyph: no lucide icon says "AR", and two letters are clearer
	     than a third near-identical 18px pictogram (the toolbox icons-vs-words rule) -->
	<button
		id="ar-enter-button"
		class="fixed bottom-4 flex h-9 w-9 items-center justify-center rounded-full bg-gray-700 text-xs font-bold text-white shadow-lg transition-colors hover:bg-gray-600"
		style="left: calc(50% + 36px); z-index: var(--z-hud);"
		title="Enter AR (passthrough)"
		aria-label="Enter AR — the scene composites over your room"
		onclick={enterAR}
	>
		AR
	</button>
{/if}
