<script lang="ts">
    import { onDestroy, untrack } from 'svelte'
    import { Euler, Camera } from 'three'
    import { useThrelte, useParent, useTask } from '@threlte/core'
    import { isLocked, playerCam, editorCam, globalScene } from '../../stores/sceneStore'
    import { userdata, peers } from '../../stores/appStore'
    import { dungeonData, slideMove, spawnPointFor } from '$lib/dungeonPlay'
    import { resolvePlaySettings } from '$lib/playSettings'
    import { inputClaims } from '$lib/inputRuntime'

    const { renderer, camera, invalidate } = useThrelte()
  
    const domElement = renderer.domElement
    const cameraParent = useParent()

    let { minPolarAngle, maxPolarAngle, pointerSpeed, moveSpeed } = $props()
    minPolarAngle = 0 // radians
    maxPolarAngle = Math.PI // radians
    pointerSpeed = 1.0    
    moveSpeed = .1
    
    let moveState = { forward: 0, backward: 0, left: 0, right: 0, up: 0, down: 0 };

    const _euler = new Euler(0, 0, 0, 'YXZ')
    const _PI_2 = Math.PI / 2
  
    if (!renderer) {
      throw new Error('Threlte Context missing: Is <PointerLockControls> a child of <Canvas>?')
    }
  
    const isCamera = (p: any): p is Camera => {
      return p.isCamera
    }
  
    if (!isCamera($cameraParent)) {
      throw new Error('Parent missing: <PointerLockControls> need to be a child of a <Camera>')
    }
  
    const onChange = () => {
      invalidate()
    }
  
        $effect(() => {
      if ($isLocked) {
        // returns a promise in newer Chrome; rejection (headless, unsupported
        // unadjustedMovement) already surfaces via the pointerlockerror event
        const request: any = domElement.requestPointerLock({
          unadjustedMovement: true
        })
        request?.catch?.(() => {})
        // dungeon spawn (58.2): entering play with a dungeon present drops you
        // in your seed-deterministic room (peers take consecutive rooms).
        // untracked: the effect must only depend on $isLocked.
        untrack(() => {
          const data = dungeonData($globalScene)
          // resolve the rig ONCE and mutate the object: `$cameraParent.position.x = v`
          // compiles to store_mutate -> cameraParent.set(), and useParent() is a
          // READ-ONLY store (no .set) — it threw "store.set is not a function"
          // and aborted the spawn, dropping everyone in the same room.
          const rig: any = $cameraParent
          if (data && rig) {
            const my = ($peers as any)?.peer?.id ?? 'me'
            const spawn = spawnPointFor(data, ($userdata ?? []).map((u: any) => u[0]), my)
            if (spawn) {
              rig.position.x = spawn.x
              rig.position.y = 0.8
              rig.position.z = spawn.z
            }
          }
        })
      }
    })

    useTask(
    (delta) => {

      // K-C: a module claimed the keys (possession) — WASD drives IT, not the camera
      if ($inputClaims.includes('keys')) return

      const beforeX = $cameraParent?.position.x ?? 0
      const beforeZ = $cameraParent?.position.z ?? 0

      if (moveState.forward === 1) {
        $cameraParent.translateZ(-moveSpeed);
      }

      if (moveState.backward === 1) {
        $cameraParent.translateZ(moveSpeed);
      }

      if (moveState.left === 1) {
        $cameraParent.translateX(-moveSpeed);
      }

      if (moveState.right === 1) {
        $cameraParent.translateX(moveSpeed);
      }

      // 21-B B3 (DEVX #14): a GROUNDED scene has no Q/E flight and pins the rig
      // to eye height, so a module no longer has to swallow those keys itself.
      const play = resolvePlaySettings($globalScene)

      if (!play.grounded && moveState.up === 1) {
        $cameraParent.translateY(-moveSpeed);
      }

      if (!play.grounded && moveState.down === 1) {
        $cameraParent.translateY(moveSpeed);
      }

      if (play.grounded && $isLocked && $cameraParent) {
        const grounded: any = $cameraParent
        grounded.position.y = play.eyeHeight
      }

      // dungeon collision (58.1): slide the XZ step along the raster walls
      const rig: any = $cameraParent
      if ($isLocked && rig) {
        const data = dungeonData($globalScene)
        if (data) {
          // same store_mutate trap as the spawn above — mutate the resolved rig
          const c = slideMove(data, beforeX, beforeZ, rig.position.x - beforeX, rig.position.z - beforeZ, 0.3)
          rig.position.x = c.x
          rig.position.z = c.z
        }
      }

    },
    {
      autoInvalidate: false
    }
  )

    export const unlock = () => document.exitPointerLock()
  
    domElement.addEventListener('pointermove', onMouseMove)
    domElement.ownerDocument.addEventListener('pointerlockchange', onPointerlockChange)
    domElement.ownerDocument.addEventListener('pointerlockerror', onPointerlockError)
    domElement.ownerDocument.addEventListener( 'keydown', onKeyDown );
    domElement.ownerDocument.addEventListener( 'keyup', onKeyUp );
    window.addEventListener('wheel', onScroll)

    onDestroy(() => {
      domElement.removeEventListener('pointermove', onMouseMove)
      domElement.ownerDocument.removeEventListener('pointerlockchange', onPointerlockChange)
      domElement.ownerDocument.removeEventListener('pointerlockerror', onPointerlockError)
      domElement.ownerDocument.removeEventListener( 'keydown', onKeyDown );
      domElement.ownerDocument.removeEventListener( 'keyup', onKeyUp );
      window.removeEventListener('wheel', onScroll)
    })

    function onScroll( event ) {
      if (!$isLocked) return
      if (!$cameraParent) return
      // 21-B B3: playInteract claims the wheel in CAPTURE phase while carrying
      // something, and says so on the event — never through a one-shot store
      // flag (the twin-Escape lesson)
      if (event.defaultPrevented) return
      moveSpeed = Math.min(1, Math.max(0.01, moveSpeed + (event.deltaY > 0 ? -0.01 : 0.01)))
    }

    function onKeyDown( event ) {
      switch ( event.code ) {
        case 'KeyW': moveState.forward = 1; break;
        case 'KeyS': moveState.backward = 1; break;
        case 'KeyA': moveState.left = 1; break;
        case 'KeyD': moveState.right = 1; break;
        case 'KeyQ': moveState.up = 1; break;
        case 'KeyE': moveState.down = 1; break;
        case 'Escape':
          // native pointer-lock Esc handles the normal case; this also rescues
          // the stuck state where play mode engaged but the lock never did
          if ($isLocked) {
            if (document.pointerLockElement) document.exitPointerLock()
            else $isLocked = false
          }
          break;
      }
    }

    function onKeyUp( event ) {
      switch ( event.code ) {
        case 'KeyW': moveState.forward = 0; break;
        case 'KeyS': moveState.backward = 0; break;
        case 'KeyA': moveState.left = 0; break;
        case 'KeyD': moveState.right = 0; break;
        case 'KeyQ': moveState.up = 0; break;
        case 'KeyE': moveState.down = 0; break;
      }
    }
  
    function onMouseMove(event: MouseEvent) {
      if (!$isLocked) return
      if (!$cameraParent) return
  
      const { movementX, movementY } = event
  
      _euler.setFromQuaternion($cameraParent.quaternion)
  
      _euler.y -= movementX * 0.002 * pointerSpeed
      _euler.x -= movementY * 0.002 * pointerSpeed
  
      _euler.x = Math.max(_PI_2 - maxPolarAngle, Math.min(_PI_2 - minPolarAngle, _euler.x))
  
      $cameraParent.quaternion.setFromEuler(_euler)
  
      onChange()
    }
  
    // threlte's context camera is a runeToCurrentWritable: `current` is a
    // GETTER ONLY, so `camera.current = x` throws "Cannot set property current
    // ... which has only a getter" and the swap never happened (play mode kept
    // rendering the editor camera). Write through .set().
    // `held` also makes this document-level listener ignore locks it does NOT
    // own — anything else that requests pointer lock (module possess with
    // mouseLook) used to yank $isLocked and the camera with it.
    let held = false

    function onPointerlockChange() {
      if (document.pointerLockElement === domElement) {
        held = true
        $isLocked = true
        camera.set($playerCam)
      } else if (held) {
        held = false
        $isLocked = false
        camera.set($editorCam)
      }
    }
  
    function onPointerlockError() {
      console.error('PointerLockControls: Unable to use Pointer Lock API')
    }
  </script>