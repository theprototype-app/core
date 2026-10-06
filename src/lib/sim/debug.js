// 36-sim: the debug-hook surface (registered in debugHooks.js as 'sim') — one module so
// e2e suites reach every simulation runtime through one name.
export { jiggleDebug, kickJiggle, resetJiggle, jiggleTargets } from './jiggleRuntime.js';
export { fluidDebug, resetFluid } from './fluidRuntime.js';
export { setFluidFor } from './fluidActions.js';
export { normalizeFluid, FLUID_DEFAULTS } from './fluidCore.js';
export { normalizeFloats, FLOAT_PRESETS, expectedDraft } from './buoyancy.js';
export { queryWater, waterSurfaceAt, beginWaterFrame, ensureWaterRoot } from './waterQuery.js';
export { waterVolumes } from '../water/volumes.js';
export { pourDebug, totalDropCount, resetPours, normalizePour } from '../water/pourDrops.js'; // 36-fb-water F16/F17
// 36-fb F23-F25: fluid emitters, flow paths, the rotor
export { fluidEmitterDebug, fluidEmitterParticles, resetFluidEmitters, setFluidTierForTest } from './fluidEmitterRuntime.js';
export { setFluidEmitterFor, setFluidInteractionFor, setFlowPathFor } from './fluidEmitterActions.js';
export { flowPathDebug } from './flowPaths.js';
export { normalizeFlowPath, floatAt } from './flowPathCore.js';
export { normalizeEmitter, EMITTER_DEFAULTS } from './fluidEmitterCore.js';
