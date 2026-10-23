<script lang="ts">
	// 56 C8: the chat's pictures — one LOCAL row inside Settings ▸ AI (the AiSttSettings precedent).
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import { keepSentPictures } from '$lib/chat/attachments.js';
</script>

<div data-keywords="picture photo image attach chat references exif gps location">
	<SettingRow
		id="row-chat-keep-pictures"
		label="Keep sent pictures in Explorer"
		description="Every picture you send to an AI chat also lands in Explorer ▸ References, where it syncs and saves with the scene. Off: press Keep in Explorer on the pictures you want. Location data is always removed before a picture is sent."
	>
		<Toggle id="chat-keep-pictures" label="Keep sent pictures in Explorer" bind:checked={$keepSentPictures} />
	</SettingRow>
</div>
