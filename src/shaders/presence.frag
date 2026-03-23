// Presence — a structured wisp of living energy.
// Not a bright blob — a fibrous, swirling entity with internal structure.
// Tendrils wind around a soft core. Breathes and reacts to voice.

precision highp float;

uniform float uTime;
uniform float uBreathValue;
uniform float uVoiceEnergy;
uniform float uAudioEnergy;
uniform float uAudioBass;
uniform float uIntensity;
uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform vec3 uPulseColor;   // target color for emotional pulses (set from JS)
uniform float uPulseAmount; // 0 = base color, 1 = fully pulse color
uniform float uRimWarp;     // 0 = calm, 1 = turbulent (driven by voice/emotion)

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
  return noise(p) * 0.5 + noise(p * 2.1) * 0.3 + noise(p * 4.3) * 0.2;
}

void main() {
  vec2 uv = vUv - 0.5;
  float r = length(uv);
  float angle = atan(uv.y, uv.x);

  float t = uTime;
  float br = uBreathValue;

  // ── Dense core mass — a structured sphere, not a point ──
  float corePulse = 1.0 + uVoiceEnergy * 0.3 + uAudioBass * 0.15;

  // ── The sphere body — a dense, mostly-solid mass at the center ──
  // This is what the tendrils emerge FROM. It should read as a glowing orb.

  // Outer envelope — compact sphere boundary
  float sphereSize = 0.08 * corePulse;
  float sphereDist = r / sphereSize;
  float sphereEnv = 1.0 - smoothstep(0.0, 1.0, sphereDist);
  sphereEnv *= sphereEnv;

  // Inner core — tight, bright
  float innerSize = 0.045 * corePulse;
  float innerEnv = exp(-r * r / (innerSize * innerSize));

  // The sphere body gets LIGHT texture — mostly solid, just enough variation
  // to feel alive, not enough to break the mass apart.
  float bodyTex = noise(vec2(angle * 2.0 + t * 0.3, r * 8.0 - t * 0.15));
  bodyTex = 0.82 + bodyTex * 0.18; // 82-100% — subtle variation, reads as solid

  // Surface detail — finer noise visible on the sphere surface, not inside
  float surfaceTex = fbm(vec2(angle * 4.0 - t * 0.4, r * 16.0 + t * 0.2));
  float surfaceRing = smoothstep(0.7, 1.0, sphereDist) * (1.0 - smoothstep(1.0, 1.3, sphereDist));
  float surfaceDetail = surfaceTex * surfaceRing * 0.3; // only visible at the sphere edge

  // Combine body: strong inner core + visible outer sphere + surface detail
  float core = innerEnv * bodyTex * 0.8 + sphereEnv * bodyTex * 0.65 + surfaceDetail;

  // Bright seed — the hottest point, small
  float seed = exp(-r * r / (0.018 * 0.018)) * 0.3;

  // ── Swirling tendrils — 5 layers at different speeds/colors ──

  // Layer 1: primary arms — just past the sphere edge
  float s1 = angle + t * 0.12 + r * 1.5;
  float f1 = fbm(vec2(s1 * 2.5, r * 7.0 - t * 0.25));
  f1 = smoothstep(0.3, 0.6, f1);
  float t1 = f1 * exp(-r / (0.10 + br * 0.02 + uVoiceEnergy * 0.04));

  // Layer 2: counter-rotation
  float s2 = -angle + t * 0.2 + r * 2.5;
  float f2 = fbm(vec2(s2 * 3.5 + 3.0, r * 9.0 + t * 0.15));
  f2 = smoothstep(0.32, 0.62, f2);
  float t2 = f2 * exp(-r / (0.09 + br * 0.02)) * 0.7;

  // Layer 3: dense core spiral — fills the sphere interior
  float s3 = angle * 2.0 + t * 0.3 - r * 3.0;
  float f3 = fbm(vec2(s3 * 4.0 + 7.0, r * 12.0 - t * 0.35));
  f3 = smoothstep(0.25, 0.55, f3);
  float t3 = f3 * exp(-r / (0.08 + br * 0.015)) * 0.6;

  // Layer 4: short outer wisps
  float s4 = -angle * 0.8 - t * 0.08;
  float f4 = noise(vec2(s4 * 2.0 + 11.0, r * 5.0 + t * 0.1));
  f4 = smoothstep(0.4, 0.7, f4);
  float t4 = f4 * exp(-r / (0.11 + uVoiceEnergy * 0.04)) * 0.3;

  // Layer 5: fine interior threads
  float s5 = angle * 1.7 - t * 0.4 + r * 4.0;
  float f5 = noise(vec2(s5 * 6.0, r * 16.0 - t * 0.5));
  f5 = smoothstep(0.5, 0.75, f5);
  float t5 = f5 * exp(-r / (0.06 + uVoiceEnergy * 0.02)) * 0.3;

  float tendrils = t1 + t2 + t3 + t4 + t5;

  // ── Parallax depth shells ──
  float breathShift = br * 0.008;
  vec2 innerUv = uv + vec2(breathShift * 0.4, -breathShift * 0.25);
  float innerR = length(innerUv);
  float innerGlow = exp(-innerR * innerR / (0.05 * 0.05)) * 0.25;

  // ── Ripples — subtle concentric waves ──
  float rippleSpeed = 0.5 + uVoiceEnergy * 0.4;
  float ripple = sin(r * 12.0 - t * rippleSpeed) * 0.5 + 0.5;
  ripple *= exp(-r * 6.0) * 0.05;

  // ── Shimmer — specks in fibers ──
  float shimmer = noise(vec2(angle * 8.0 + t * 1.2, r * 15.0 - t * 0.8));
  shimmer = pow(shimmer, 3.0);
  shimmer *= exp(-r * 4.0) * 0.1;

  // ── Combine — core provides mass, tendrils provide structure ──
  float brightness = seed + core + innerGlow + tendrils * 0.5 + ripple + shimmer;

  // ── Color — sphere body is distinctly brighter/warmer than tendrils ──
  vec3 color = uColor;

  // Sphere body: warm, bright — clearly distinct from tendril color
  float bodyMask = sphereEnv + innerEnv * 0.5; // strong inside the sphere
  color = mix(color, uCoreColor, bodyMask * 0.6 + seed * 0.4);

  // Primary tendrils: base color
  color = mix(color, uColor * 1.15, t1 * 0.25);

  // Counter-rotation tendrils: slightly shifted hue (more blue/cool)
  vec3 coolTint = vec3(uColor.r * 0.8, uColor.g * 0.9, min(1.0, uColor.b * 1.3));
  color = mix(color, coolTint, t2 * 0.2);

  // Inner spiral: warm accent
  color = mix(color, uCoreColor * 1.1, t3 * 0.15);

  // Outer wisps: dimmer, more saturated
  color = mix(color, uColor * 0.9, t4 * 0.15);

  // Fine detail: bright specks
  color += uCoreColor * t5 * 0.12;

  // ── Color pulse — driven from JS for breathing, emotion, transitions ──
  if (uPulseAmount > 0.01) {
    // Pulse radiates from center outward
    float pulseMask = (1.0 - r * 4.0);
    pulseMask = clamp(pulseMask, 0.0, 1.0);
    color = mix(color, uPulseColor, uPulseAmount * pulseMask);
  }

  // ── Intensity + falloff ──
  brightness *= 0.4 + uIntensity * 0.6;

  // Organic edge fade — warped boundary (more turbulent with uRimWarp)
  float edgeWarpAmt = 0.01 + uRimWarp * 0.06;
  float edgeWarp = noise(vec2(sin(angle * 4.0) - t * 0.3, cos(angle * 4.0) + t * 0.15)) * edgeWarpAmt;
  float edgeFade = smoothstep(0.25 + edgeWarp, 0.08, r);
  brightness *= edgeFade;

  // Presence rim — calm circle with voice-driven "speaking" deformation
  float warpAmt = 0.005 + uRimWarp * 0.02;
  // Organic slow warp (always present)
  float rimWarp = noise(vec2(sin(angle * 3.0) + t * 0.5, cos(angle * 3.0) + t * 0.2)) * warpAmt;

  // Voice wave — standing wave modes driven by actual audio frequency bands.
  // Low freqs (bass) drive slow modes, mid/high drive faster modes.
  // This makes the rim deformation match what you actually hear.
  float voiceWave = sin(angle * 2.0 + t * 2.0) * uAudioBass * 0.5     // bass: slow, wide
                  + sin(angle * 3.0 - t * 3.5) * uVoiceEnergy * 0.4    // voice: mid mode
                  + sin(angle * 5.0 + t * 5.0) * uAudioEnergy * 0.25   // energy: faster
                  + sin(angle * 7.0 - t * 7.0) * uVoiceEnergy * 0.15;  // detail: fine
  voiceWave *= 0.012; // scale — subtle enough to read as "speaking" not "exploding"
  rimWarp += voiceWave;

  float rimR = 0.09 + rimWarp;
  float rimDist = abs(r - rimR);
  float rim = exp(-rimDist * rimDist / (0.006 * 0.006)) * 0.45;
  brightness += rim * edgeFade;

  // Floor: core always slightly visible
  brightness = max(brightness, core * 0.2);

  gl_FragColor = vec4(color * brightness, brightness);
}
