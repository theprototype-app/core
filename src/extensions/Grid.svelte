<script lang="ts">
    import { Grid } from '@threlte/extras'
    let { showGrid } = $props()
  </script>
  
   {#if showGrid}
    <Grid
      infiniteGrid
      renderOrder={9999}
      position={[0,0,0.03]}
      cellColor={0x484d55}
      sectionColor={0x77808d}
      sectionThickness={1.2}
      fadeDistance={100}
      fadeStrength={1.5}
      />
  {/if}
