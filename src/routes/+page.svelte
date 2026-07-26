<script>
	import App from '../App.svelte'
</script>
  
  <div>
	<App />
  </div>
  
  <style>
	:global(body, html) {
	  margin: 0;
	  /* full-viewport app: nothing scrolls the document (panels/modals scroll
	     internally). Clip here so a floating window shoved off the RIGHT/bottom edge
	     can't grow the page and spawn scrollbars - matching the left edge, where
	     negative offsets never did. This also stops the centred Connect pill shifting. */
	  overflow: hidden;
	}
  
	div {
	  position: absolute;
	  height: 100%;
	  width: 100%;
	  overflow: hidden;
	}
  </style>