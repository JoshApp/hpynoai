// Core
export { Compositor } from './compositor';
export { PropertyChannel, Vec3Channel } from './channel';

// Layers
export { FadeLayer } from './layers/fade';
export { CameraLayer } from './layers/camera';
export { TunnelLayer } from './layers/tunnel';
export { FeedbackLayer } from './layers/feedback';
export { ParticlesLayer } from './layers/particles';

// Actors
export { TextActor } from './actors/text';
export { NarrationActor } from './actors/narration';
export { BreathActor } from './actors/breath';
export { AudioClipActor } from './actors/audio-clip';

// Types
export type {
  Layer, Actor, Config, Preset, WorldInputs, RenderContext,
  ActorDirective, EasingFn,
  TunnelPreset, FeedbackPreset, CameraPreset, ParticlesPreset, FadePreset,
  PresenceDirective, TextDirective, NarrationDirective, BreathDirective, AudioClipDirective,
} from './types';
export { easings } from './types';
