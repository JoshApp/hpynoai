// Energy presence — a living wisp of light.
// Ripples like a drop in still water. Shimmers gently.
// Core pulses with voice. Tendrils breathe with you.

precision highp float;

uniform float uTime;
uniform float uBreathValue;
uniform float uVoiceEnergy;
uniform float uAudioEnergy;
uniform float uAudioBass;
uniform float uIntensity;
uniform vec3 uColor;
uniform vec3 uCoreColor;

varying vec2 vUv;

#define PI 3.14159265359
#define TAU 6.28318530718

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p *= 2.1;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = vUv - 0.5;
  float r = length(uv);
  float angle = atan(uv.y, uv.x);

  float t = uTime;

  // ── Ripples — very slow, gentle concentric waves ──
  float rippleSpeed = 0.6 + uVoiceEnergy * 0.5;
  float rippleFreq = 8.0;
  float ripple1 = sin(r * rippleFreq - t * rippleSpeed) * 0.5 + 0.5;
  float ripples = ripple1;
  float rippleStrength = exp(-r * 5.0) * (0.08 + uVoiceEnergy * 0.12);
  ripples *= rippleStrength;

  // ── Core — warm center, visible but not blinding ──
  float corePulse = 1.0 + uVoiceEnergy * 0.4 + uAudioBass * 0.2;
  float coreSize = 0.07 * corePulse;
  float core = exp(-r * r / (coreSize * coreSize));
  // Subtle inner point — bright but not pure white
  float innerCore = exp(-r * r / (0.025 * 0.025)) * 0.3;

  // ── Aura — soft glow that breathes ──
  float breathSize = 0.14 + uBreathValue * 0.05;
  float aura = exp(-r * r / (breathSize * breathSize));
  aura *= 0.5 + uBreathValue * 0.3;

  // ── Shimmer — very subtle, slow sparkle ──
  float shimmerNoise = noise(vec2(angle * 5.0 + t * 0.8, r * 10.0 - t * 0.5));
  float shimmer = shimmerNoise * exp(-r * 5.0) * 0.1;
  shimmer *= 1.0 + uVoiceEnergy * 0.5;

  // ── Wisps/tendrils — organic rays reaching outward ──
  float wispAngle = angle + t * 0.2;
  float wispNoise = fbm(vec2(wispAngle * 2.5, r * 6.0 - t * 0.4));
  float wispReach = 0.18 + uVoiceEnergy * 0.1 + uBreathValue * 0.04;
  float wispFalloff = exp(-r / wispReach);
  float wisps = wispNoise * wispFalloff * 0.5;
  // Second wisp layer rotating opposite direction
  float wisp2 = fbm(vec2(-wispAngle * 3.0 + 2.0, r * 8.0 + t * 0.3));
  wisps += wisp2 * exp(-r / (wispReach * 0.8)) * 0.3;

  // ── Combine layers ──
  float brightness = innerCore + core + aura * 0.4 + wisps + shimmer + ripples;

  // ── Color: tinted throughout, never pure white ──
  vec3 color = uColor;
  // Core brightens toward core color (tinted, not white)
  color = mix(color, uCoreColor, core * 0.5 + innerCore * 0.6);
  // Ripples carry the base color
  color = mix(color, uColor * 1.3, ripples * 0.4);
  // Wisps are a mix of base and core
  color = mix(color, mix(uColor, uCoreColor, 0.4), wisps * 0.3);

  // ── Intensity + opacity ──
  brightness *= 0.4 + uIntensity * 0.6;

  // Circular falloff
  float edgeFade = smoothstep(0.5, 0.3, r);
  brightness *= edgeFade;

  // Minimum visibility — always slightly visible even at low intensity
  brightness = max(brightness, core * 0.3);

  gl_FragColor = vec4(color * brightness, brightness);
}
