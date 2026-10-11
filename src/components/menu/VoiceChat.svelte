<script lang="ts">
	import { remoteStreams, mutedPeers, spatialVoice } from '$lib/voiceChat';

	// hidden audio sinks for remote voices (41 G1: the mic button lives in Controls now).
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

<!-- 41 G1: the mic toggle moved into Controls.svelte's roster (a corner-stack or bar button,
     id #mic-button, same title and toggleMic) so it can be moved and removed like the rest -->
