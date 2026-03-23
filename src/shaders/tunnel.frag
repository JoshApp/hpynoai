// ═══════════════════════════════════════════════════════════════
// HPYNO Tunnel v2 — clean rewrite
//
// Classic demoscene tunnel: depth = 1/r in polar space.
// One coherent lighting model, no stacked darkening passes.
//
// Structure:
//   1. Polar coords + organic distortion
//   2. Depth mapping + forward scroll
//   3. Wall texture (rings, segments, patterns, noise)
//   4. Lighting (one pass: cylindrical normal + depth + fog)
//   5. Center glow
//   6. Vignette + breath
//   7. Final output
// ═══════════════════════════════════════════════════════════════

uniform float uTime;
uniform float uIntensity;
uniform vec2  uMouse;
uniform float uBreathValue;
uniform float uBreathStage;
uniform float uBreathePhase;
uniform float uSpiralSpeed;
uniform float uSpiralAngle;
uniform float uTunnelSpeed;
uniform float uTunnelWidth;
uniform float uBreathExpansion;
uniform float uTunnelShape;
uniform vec2  uResolution;
uniform vec3  uColor1; // primary
uniform vec3  uColor2; // secondary
uniform vec3  uColor3; // accent
uniform vec3  uColor4; // background / deep

uniform float uAudioEnergy;
uniform float uAudioBass;
uniform float uAudioMid;
uniform float uAudioHigh;
uniform float uVoiceEnergy;

uniform float uBreathSyncActive;
uniform float uBreathSyncFill;
uniform float uBreathSyncProgress;

varying vec2 vUv;

#define PI  3.14159265359
#define TAU 6.28318530718

// ── Noise ──────────────────────────────────────────────────────
float hash(float n) { return fract(sin(n) * 43758.5453); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f); // smoothstep
  float n = i.x + i.y * 157.0;
  return mix(
    mix(hash(n),         hash(n + 1.0),   f.x),
    mix(hash(n + 157.0), hash(n + 158.0), f.x),
    f.y
  );
}

// ═══════════════════════════════════════════════════════════════
void main() {
  vec2 uv = vUv - 0.5;
  float aspect = uResolution.x / uResolution.y;
  uv.x *= aspect;

  float br = uBreathValue;

  // ────────────────────────────────────────────────────────────
  // 1. POLAR COORDINATES
  // ────────────────────────────────────────────────────────────
  // Mouse adds subtle offset
  uv += uMouse * 0.04 * uIntensity;

  float r     = length(uv);
  float angle = atan(uv.y, uv.x);

  // Organic distortion (uTunnelShape: 0 = geometric, 1 = organic)
  if (uTunnelShape > 0.01) {
    float org = uTunnelShape;
    float t   = uTime;
    // Radial folds — non-circular cross-section
    r += (sin(angle * 3.0 + t * 0.2)  * 0.06
        + sin(angle * 5.0 - t * 0.15) * 0.03
        + sin(angle * 7.0 + t * 0.3)  * 0.015)
        * org * (0.5 + br * 0.5);
    // Peristaltic wave along depth
    r += (sin(r * 15.0 - t * 1.5) * 0.02
        + sin(r * 8.0  + t * 0.8) * 0.015) * org;
    // Asymmetric opening
    r += uv.x * sin(t * 0.1) * 0.02 * org
       + uv.y * cos(t * 0.13) * 0.015 * org;
    // Warm throb
    r *= 1.0 - (sin(t * 0.7) * 0.5 + 0.5) * 0.03 * org;
  }

  // ────────────────────────────────────────────────────────────
  // 2. DEPTH MAPPING
  // ────────────────────────────────────────────────────────────
  // Breath bulge — tunnel mouth opens/closes
  float bulgeFall = exp(-pow((r - 0.20) / 0.18, 2.0));
  float bulgedR   = r - bulgeFall * (br - 0.5) * 0.10 * uBreathExpansion;

  // Classic tunnel: depth = 1/r (clamped to prevent infinity at center)
  float sr    = bulgedR / uTunnelWidth;
  float depth = 0.5 / (max(sr, 0.01) + 0.03);

  // Subtle breath depth shift
  depth += (br - 0.5) * 0.03 * uBreathExpansion;

  // Multi-timescale: tunnel's own slow rhythm
  depth += sin(uTime * 0.25) * 0.012;  // ~25s
  depth += sin(uTime * 0.07) * 0.006;  // ~90s glacial

  // Scrolling forward
  float z = depth + uTime * 0.6 * uTunnelSpeed;

  // ────────────────────────────────────────────────────────────
  // 3. TEXTURE COORDINATES
  // ────────────────────────────────────────────────────────────
  float rawDepth     = 0.4 / (r / uTunnelWidth + 0.05);
  float twist        = uSpiralAngle + rawDepth * 0.3;
  float twistedAngle = angle + twist;
  float texU         = twistedAngle / TAU + 0.5; // around tube
  float texV         = z;                         // along tube

  // ────────────────────────────────────────────────────────────
  // 4. WALL TEXTURE
  // ────────────────────────────────────────────────────────────
  // Rings — the primary depth cue
  float ringFreq = mix(14.0, 7.0, uTunnelShape);
  float rings    = sin(texV * ringFreq) * 0.5 + 0.5;
  rings = smoothstep(
    mix(0.25, 0.10, uTunnelShape),
    mix(0.65, 0.80, uTunnelShape),
    rings
  );
  rings *= 1.0 + uAudioBass * 0.4; // bass pumps rings

  // Segment lines — radial structure
  float segCount = mix(12.0, 3.0, uTunnelShape);
  float segLines = abs(sin(twistedAngle * segCount));
  segLines = smoothstep(mix(0.92, 0.98, uTunnelShape), 0.99, segLines);
  segLines *= 1.0 - uTunnelShape * 0.7;

  // Flowing patterns
  float pat1 = sin(texU * TAU * 3.0 + texV * 2.0) * 0.5 + 0.5;
  float pat2 = sin(texU * TAU * 5.0 - texV * 1.5 + uTime * 0.5) * 0.5 + 0.5;

  // Noise texture
  float nScale   = mix(0.3, 0.7, uTunnelShape);
  float wallNois = noise(vec2(twistedAngle * 2.0, texV * 0.5)) * nScale * uIntensity
                 + noise(vec2(angle * 4.0 + uTime * 0.1, texV * 0.3)) * 0.2 * uTunnelShape;

  // ────────────────────────────────────────────────────────────
  // 5. COLOR — single accumulation path
  // ────────────────────────────────────────────────────────────
  // Slow color evolution (prevents loop feel)
  float slowDrift    = sin(uTime * 0.04) * 0.5 + 0.5;  // ~40s
  float glacialDrift = sin(uTime * 0.017) * 0.5 + 0.5; // ~60s
  float medPulse     = sin(uTime * 0.35) * 0.5 + 0.5;  // ~18s

  // Base wall: blend primary ↔ secondary via pattern + slow drift
  float balance = clamp(pat1 + (slowDrift - 0.5) * 0.15, 0.0, 1.0);
  vec3 wall = mix(uColor1, uColor2, balance);

  // Accent washes
  wall = mix(wall, uColor3, glacialDrift * 0.08 * uIntensity);
  wall = mix(wall, uColor3, pat2 * br * uIntensity * 0.4 + medPulse * 0.04 * uIntensity);
  wall = mix(wall, uColor2, uAudioMid * 0.15);

  // Ring highlights
  vec3 ringCol = uColor3 * 1.6 + uColor2 * uAudioHigh * 0.5;
  wall = mix(wall, ringCol, rings * 0.5 * uIntensity);

  // Segment lines
  wall += uColor3 * segLines * 0.3 * uIntensity;

  // Noise variation
  wall *= 1.0 + wallNois;

  // Voice warmth
  wall += uColor3 * uVoiceEnergy * 0.12;

  // ────────────────────────────────────────────────────────────
  // 6. LIGHTING — one unified pass
  // ────────────────────────────────────────────────────────────
  // a) Cylindrical shading: light from above — subtle, not heavy
  float cylLight = 0.82 + 0.18 * cos(angle - PI * 0.5);

  // b) Depth gradient: near walls bright, far walls dim
  float depthLight = 0.3 + 0.7 * smoothstep(0.0, 2.5, depth);

  // c) Curve shading: turning illusion
  vec2 curveDir = vec2(
    sin(uTime * 0.08) + sin(uTime * 0.184) * 0.3,
    cos(uTime * 0.056) + sin(uTime * 0.144) * 0.25
  );
  float cLen = length(curveDir);
  curveDir = cLen > 0.01 ? curveDir / cLen : vec2(0.0);
  float curveLight = 1.0 + dot(normalize(uv + 0.001), curveDir) * min(cLen * 0.08, 0.08) * 0.5;

  // d) Depth fog: fade to darkness at extreme distance
  float fogMix = 1.0 - exp(-depth * 0.08);

  // Apply lighting in one multiply (no stacking!)
  wall *= cylLight * depthLight * curveLight;

  // Fog blends toward deep color
  wall = mix(wall, uColor4 * 0.25, fogMix);

  // ────────────────────────────────────────────────────────────
  // 7. CENTER GLOW — the hypnotic attractor
  // ────────────────────────────────────────────────────────────
  float centerFall = exp(-r * 4.0);
  float glow       = centerFall * (0.85 + uIntensity * 0.15) * (0.85 + br * 0.15);
  glow += exp(-r * 7.0) * uVoiceEnergy * 0.2;
  vec3 glowCol = mix(uColor3, vec3(1.0), 0.55);
  wall = mix(wall, glowCol, glow);

  // Pulse rings — ripples from center (not at r≈0)
  float pulseSpd   = 2.0 + uAudioBass * 3.0;
  float pulseRings = sin(r * 20.0 - uTime * pulseSpd) * 0.5 + 0.5;
  pulseRings *= exp(-r * 3.0) * (1.0 - exp(-r * 8.0)) * uIntensity * 0.08;
  pulseRings *= 1.0 + uAudioEnergy * 0.15;
  wall += uColor2 * pulseRings;

  // ────────────────────────────────────────────────────────────
  // 8. CHROMATIC ABERRATION
  // ────────────────────────────────────────────────────────────
  float aber = uIntensity * 0.004;
  wall.r *= 1.0 + r * aber * 8.0;
  wall.b *= 1.0 - r * aber * 4.0;

  // ────────────────────────────────────────────────────────────
  // 9. BREATH-SYNC INTERACTION
  // ────────────────────────────────────────────────────────────
  if (uBreathSyncActive > 0.5) {
    float band = exp(-pow((r - 0.18) / 0.12, 2.0));
    wall += uColor3 * band * uBreathSyncFill * 0.35;
    wall *= 1.0 + uBreathSyncFill * br * 0.1;
    wall += uColor3 * band * uBreathSyncProgress * 0.18;
  }

  // ────────────────────────────────────────────────────────────
  // 10. ATMOSPHERIC FOG — wispy noise at edges (baked in, no extra draw call)
  // ────────────────────────────────────────────────────────────
  float vr = length(vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5)) * 2.0;
  float fogRadial = smoothstep(0.15, 0.8, vr);
  float brFogMod  = 0.85 + (1.0 - br) * 0.15;
  // 3 fog layers at different scales/speeds — one noise call each
  float fogFar  = noise(uv * 1.5 + vec2(uTime * 0.02, uTime * 0.015));
  float fogMid2 = noise(uv * 2.5 - vec2(uTime * 0.04, uTime * 0.03) + vec2(5.0));
  float fogNear = noise(uv * 4.0 + vec2(uTime * 0.07, uTime * 0.05) + vec2(10.0));
  vec3 fogAccum = uColor4 * smoothstep(0.35, 0.6, fogFar) * 0.04
                + mix(uColor1, uColor3, 0.4) * smoothstep(0.35, 0.6, fogMid2) * 0.03
                + uColor3 * smoothstep(0.35, 0.6, fogNear) * 0.02;
  wall += fogAccum * fogRadial * brFogMod * uIntensity;

  // ────────────────────────────────────────────────────────────
  // 11. VIGNETTE — breathing darkness frame
  // ────────────────────────────────────────────────────────────

  float breathOpen = br * uBreathExpansion;
  float vigInner   = 0.28 - uIntensity * 0.12 + breathOpen * 0.10;
  float vigOuter   = 0.62 - uIntensity * 0.08 + breathOpen * 0.06;
  float vig        = smoothstep(vigInner, vigOuter, vr);
  vig = max(vig, 0.10);
  vig *= 0.5 + uIntensity * 0.45;
  wall *= 1.0 - vig;

  // Peripheral breath tint
  float edgeMask = smoothstep(0.5, 0.9, vr);
  wall += mix(uColor4 * 0.06, uColor3 * 0.12, br) * edgeMask * uBreathExpansion;

  // ────────────────────────────────────────────────────────────
  // 11. FINAL
  // ────────────────────────────────────────────────────────────
  wall *= 0.6 + 0.4 * uIntensity;
  wall *= 1.0 + uAudioEnergy * 0.15;
  wall += mix(uColor2 * 0.015, uColor3 * 0.03, br) * uBreathExpansion;

  gl_FragColor = vec4(wall, 1.0);
}
