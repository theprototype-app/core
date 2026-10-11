<script lang="ts">
	import Icon from '../ui/Icon.svelte';
	import { remoteStreams, mutedPeers, micActive, pttActive, toggleMic, spatialVoice } from '$lib/voiceChat';

	// hidden audio sinks for remote voices + the mic toggle button.
	// muted/volume are set as properties in the action — the Svelte attribute
	// binding on media elements only applies at load time. In spatial mode the
	// element stays attached at volume 0 (Chrome only pumps WebRTC audio into
	// WebAudio while a media element consumes the stream).
	function attach(node: HTMLAudioElement, params: { stream: MediaStream; muted: boolean; spatial: boolean }) {
		const apply = (p: { stream: MediaStream; muted: boolean; spatial: boolean }) => {
			if (node.srcObject !== p.stream) node.srcObject = p.stream;
			node.muted = p.muted;
			node.volume = p.spatial ? 0 : 1;
		};
		apply(params);
		return { update: apply };
	}
</script>

{#each Object.entries($remoteStreams) as [peerId, stream] (peerId)}
	<audio autoplay use:attach={{ stream, muted: $mutedPeers.includes(peerId), spatial: $spatialVoice }}></audio>
{/each}

<!-- bottom-right stack (93): mic above chat, BELOW the bottom dock's z-tier
     so an open flow editor / Explorer covers them -->
<button
	id="mic-button"
	class="tp-ui hud-fab fixed bottom-16 right-4 z-(--z-chrome)"
	class:on={$micActive || $pttActive}
	title={$micActive ? 'Microphone on — click to mute' : 'Microphone off — click to talk, or hold V for push-to-talk'}
	on:click={toggleMic}
>
	{#if $micActive || $pttActive}<Icon name="mic" size={20} aria-hidden="true" />{:else}<Icon name="mic-off" size={20} aria-hidden="true" />{/if}
</button>
