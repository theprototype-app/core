<script lang="ts">
    import { Grid } from '@threlte/extras'
    import { useThrelte, useTask } from '@threlte/core'
    let { showGrid } = $props()

    // B1 (roadmap #13): the infinite grid fades out beyond `fadeDistance` world
    // units from the camera. A fixed 100 made the grid vanish on far dolly-out
    // (cameraClip grows the far plane with the scene, but the grid didn't follow).
    // Scale the fade with the camera's distance from the origin (a proxy for zoom)
    // so the grid stays visible as you zoom out, eased so it doesn't pop.
    const { camera } = useThrelte()
    let fade = $state(100)
    useTask(() => {
      const cam = camera.current
      if (!cam) return
      const target = Math.min(Math.max(100, cam.position.length() * 1.6), 5000)
      fade += (target - fade) * 0.2
    })
  </script>

   {#if showGrid}
    <Grid
      infiniteGrid
      renderOrder={9999}
      position={[0,0,0.03]}
      cellColor={0x484d55}
      sectionColor={0x77808d}
      sectionThickness={1.2}
      fadeDistance={fade}
      fadeStrength={1.5}
      />
  {/if}
