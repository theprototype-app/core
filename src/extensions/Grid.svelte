<script lang="ts">
    import { Grid } from '@threlte/extras'
    import { useThrelte, useTask } from '@threlte/core'
    import { orbitControls } from '../stores/sceneStore'
    let { showGrid } = $props()

    // B1 (roadmap #13): the infinite grid fades out beyond `fadeDistance` world
    // units from the camera. A fixed 100 made the grid vanish on far dolly-out
    // (cameraClip grows the far plane with the scene, but the grid didn't follow),
    // so we scale the fade with the camera's zoom.
    //
    // I4 (roadmap #13): the earlier version EASED `fade` toward the target at
    // 0.2/frame. That lag made the circular fade boundary trail the camera and
    // sweep across the grid for ~0.6s after every move — a "flashing ring". Fix:
    //   - derive the zoom proxy from the orbit distance-to-TARGET (constant during a
    //     pure orbit, so orbiting no longer wobbles the ring), not origin distance;
    //   - SNAP fadeDistance to the target each frame (no lerp). During a smooth
    //     dolly the target changes smoothly, so snapping tracks the camera with no
    //     lag and no pop; a discrete camera jump just resizes the ring instantly.
    const { camera } = useThrelte()
    let fade = $state(100)
    useTask(() => {
      const cam = camera.current
      if (!cam) return
      const oc = $orbitControls
      const dist = oc?.target ? cam.position.distanceTo(oc.target) : cam.position.length()
      fade = Math.min(Math.max(100, dist * 1.6), 5000)
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
