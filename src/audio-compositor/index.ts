export { AudioCompositor } from './compositor';
export { createRNG, hashSeed } from './rng';

// Layers
export { BinauralLayer } from './layers/binaural';
export { DroneLayer } from './layers/drone';
export { PadLayer } from './layers/pad';
export { NoiseLayer } from './layers/noise';
export { SubPulseLayer } from './layers/sub-pulse';
export { BreathNoiseLayer } from './layers/breath-noise';
export { SpatialLayer } from './layers/spatial';
export { WispAudioLayer } from './layers/wisp-audio';

// Actors
export { MelodyActor } from './actors/melody';
export { SequencerActor } from './actors/sequencer';

// Types
export type { AudioLayer, AudioPreset } from './types';
export { DEFAULT_AUDIO_PRESET, midiToFreq, midiToNote, mergePreset } from './types';
