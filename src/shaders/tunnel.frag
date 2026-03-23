// WMP-style tunnel — polar coordinate warp, rings flowing toward you
// No raymarching needed — pure 2D math, extremely fast

uniform float uTime;
uniform float uIntensity;
uniform vec2 uMouse;
uniform float uBreathePhase;
uniform float uBreathValue;  // 0-1 direct from BreathController (supports holds)
uniform float uBreathStage;  // 0=inhale, 1=hold-in, 2=exhale, 3=hold-out
uniform float uSpiralSpeed;
uniform float uSpiralAngle;  // accumulated rotation (no jumps on speed change)
uniform float uTunnelSpeed;
uniform float uTunnelWidth;
uniform float uBreathExpansion;
uniform float uTunnelShape;    // 0 = geometric, 1 = organic/cervical
uniform vec2 uResolution;
uniform vec3 uColor1; // primary
uniform vec3 uColor2; // secondary
uniform vec3 uColor3; // accent
uniform vec3 uColor4; // background

// Audio-reactive uniforms (0-1, fed from AudioAnalyzer + NarrationEngine)
uniform float uAudioEnergy;  // overall audio energy
uniform float uAudioBass;    // bass band energy
uniform float uAudioMid;     // mid band energy
uniform float uAudioHigh;    // high band energy
uniform float uVoiceEnergy;  // narrator voice energy (simulated or real)

// Interaction-driven uniforms
uniform float uBreathSyncActive; // 1 when breath-sync interaction is active
uniform float uBreathSyncFill;   // 0-1 how in-sync the user is
uniform float uBreathSyncProgress; // 0-1 (goodCycles / 4)

varying vec2 vUv;

#define PI 3.14159265359
#define TAU 6.28318530718

// ── Cheap hash noise ──
float hash(float n) { return fract(sin(n) * 43758.5453123); }

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n = i.x + i.y * 157.0;
  return mix(
    mix(hash(n), hash(n + 1.0), f.x),
    mix(hash(n + 157.0), hash(n + 158.0), f.x),
    f.y
  );
}

// ── Breathing ──
float breathe() {
  // Use direct value from BreathController — supports hold phases
  return uBreathValue;
}

void main() {
  vec2 uv = vUv - 0.5;
  float aspect = uResolution.x / uResolution.y;
  uv.x *= aspect;

  // ── Tunnel path — curves simulated via asymmetric shading ──
  // Very gentle, NOT intensity-dependent — prevents rotation jumps on intensity changes
  float pathTime = uTime * 0.08; // slower path evolution
  vec2 curveDir = vec2(
    sin(pathTime * 1.0) + sin(pathTime * 2.3) * 0.3,
    cos(pathTime * 0.7) + sin(pathTime * 1.8) * 0.25
  );
  float curveMag = length(curveDir);
  curveDir = curveMag > 0.01 ? curveDir / curveMag : vec2(0.0);
  float curveAmount = min(curveMag * 0.08, 0.08); // fixed amount, no intensity scaling

  // Mouse adds subtle steering feel
  uv += uMouse * 0.04 * uIntensity;

  // Polar coordinates — center stays fixed
  float r = length(uv);
  float angle = atan(uv.y, uv.x);

  // Curve feel is handled by asymmetric brightness only (no angle rotation)
  // Angle rotation caused streak artifacts at the transition boundary

  // ── Organic shape distortion (uTunnelShape: 0=off, 1=full) ──
  if (uTunnelShape > 0.01) {
    float org = uTunnelShape;
    float t = uTime;

    // Radial folds — makes the tunnel cross-section non-circular
    // Like looking into a fleshy tube with ridges
    float folds = sin(angle * 3.0 + t * 0.2) * 0.06
                + sin(angle * 5.0 - t * 0.15) * 0.03
                + sin(angle * 7.0 + t * 0.3) * 0.015;
    r += folds * org * (0.5 + breathe() * 0.5);

    // Peristaltic wave — undulation along depth that contracts/relaxes
    // Creates the sense of muscular walls
    float wave = sin(r * 15.0 - t * 1.5) * 0.02
               + sin(r * 8.0 + t * 0.8) * 0.015;
    r += wave * org;

    // Asymmetric opening — slightly off-center, like a real passage
    float asymX = sin(t * 0.1) * 0.02 * org;
    float asymY = cos(t * 0.13) * 0.015 * org;
    r += (uv.x * asymX + uv.y * asymY);

    // Warm pulsing — the whole passage throbs gently
    float throb = sin(t * 0.7) * 0.5 + 0.5;
    r *= 1.0 - throb * 0.03 * org;
  }

  // ── Breathing ──
  float br = breathe();

  // ── Tube bulge — subtle tunnel breathing ──
  float bulgeCenter = 0.20;
  float bulgeFalloff = exp(-pow((r - bulgeCenter) / 0.18, 2.0));
  float bulgeAmount = (br - 0.5) * 0.10 * uBreathExpansion;
  float bulgedR = r - bulgeFalloff * bulgeAmount;

  // ── Tunnel depth mapping — deeper falloff for stronger 3D feel ──
  float scaledR = bulgedR / uTunnelWidth;
  float depth = 0.5 / (max(scaledR, 0.01) + 0.03);

  // Very subtle depth shift — tube bulge handles the main breathing visual
  // Large values here cause rings to race at high ringFreq
  float breathDepth = (br - 0.5) * 0.03 * uBreathExpansion;
  depth += breathDepth;

  // Forward movement — constant base speed
  float z = depth + uTime * 0.6 * uTunnelSpeed;

  // ── Tunnel texture coordinates ──
  // Angle gives us "around the tube", depth gives us "along the tube"
  float texU = angle / TAU + 0.5; // 0-1 around
  float texV = z; // along the tunnel

  // ── Spiral twist — accumulated angle + fixed depth twist (no intensity dependency) ──
  float rawDepth = 0.4 / (r / uTunnelWidth + 0.05);
  float twist = uSpiralAngle + rawDepth * 0.3;
  float twistedAngle = angle + twist;
  float texUTwisted = twistedAngle / TAU + 0.5;

  // ── Ring segments — more defined, stronger 3D illusion ──
  float ringFreq = mix(14.0, 7.0, uTunnelShape); // more rings = deeper tunnel feel
  float rings = sin(z * ringFreq) * 0.5 + 0.5;
  float ringSharpLo = mix(0.25, 0.1, uTunnelShape); // sharper ring edges
  float ringSharpHi = mix(0.65, 0.8, uTunnelShape);
  rings = smoothstep(ringSharpLo, ringSharpHi, rings);

  // Bass makes rings pulse
  float ringPulse = 1.0 + uAudioBass * 0.5;
  rings *= ringPulse;

  // ── Segment lines — fixed count to prevent rotation artifacts on intensity changes ──
  float segments = mix(12.0, 3.0, uTunnelShape);
  float segLines = abs(sin(twistedAngle * segments));
  float segThreshold = mix(0.92, 0.98, uTunnelShape); // thinner in organic mode
  segLines = smoothstep(segThreshold, 0.99, segLines);
  segLines *= (1.0 - uTunnelShape * 0.7); // fade segments in organic mode

  // ── Wall pattern — flowing organic texture ──
  float pattern1 = sin(texUTwisted * TAU * 3.0 + z * 2.0) * 0.5 + 0.5;
  float pattern2 = sin(texUTwisted * TAU * 5.0 - z * 1.5 + uTime * 0.5) * 0.5 + 0.5;

  // Noise for organic feel — much stronger in organic mode (fleshy texture)
  float noiseScale = mix(0.3, 0.7, uTunnelShape);
  float wallNoise = noise(vec2(twistedAngle * 2.0, z * 0.5)) * noiseScale * uIntensity;
  // Extra layered noise in organic mode for subsurface look
  wallNoise += noise(vec2(angle * 4.0 + uTime * 0.1, z * 0.3)) * 0.2 * uTunnelShape;

  // ── Color computation ──

  // Base wall color — spiral pattern between primary and secondary
  vec3 wallColor = mix(uColor1, uColor2, pattern1);

  // Accent color pulsing with breath
  wallColor = mix(wallColor, uColor3, pattern2 * br * uIntensity * 0.5);

  // Mid frequencies shift the color pattern
  wallColor = mix(wallColor, uColor2, uAudioMid * 0.2);

  // Ring highlights — strong accent glow on ring edges for 3D definition
  vec3 ringColor = uColor3 * 1.8;
  ringColor += uColor2 * uAudioHigh * 0.6;
  wallColor = mix(wallColor, ringColor, rings * 0.55 * uIntensity);

  // Segment lines — geometric structure
  wallColor += uColor3 * segLines * 0.35 * uIntensity;

  // Wall noise organic variation
  wallColor *= 1.0 + wallNoise;

  // Voice energy warms walls when narrator speaks
  wallColor += uColor3 * uVoiceEnergy * 0.15;

  // ── Depth shading — stronger contrast between near and far walls ──
  float depthShade = smoothstep(0.0, 2.0, depth);
  wallColor *= 0.35 + 0.65 * depthShade;

  // ── Curve shading — asymmetric brightness sells the turning illusion ──
  // The side we're "turning toward" gets brighter (wall appears closer)
  float curveDot = dot(normalize(uv + 0.001), curveDir);
  float curveShade = 1.0 + curveDot * curveAmount * 0.6;
  wallColor *= curveShade;

  // ── Fog — subtle fade at extreme depth ──
  float fog = exp(-depth * 0.08);
  wallColor = mix(wallColor, uColor4 * 0.3, 1.0 - fog);

  // ── Center glow — hypnotic pull toward the center ──
  // Steady center brightness — breath modulates gently, no strobing
  float centerFalloff = exp(-r * 4.0);
  float centerGlow = centerFalloff * (0.85 + uIntensity * 0.15);
  centerGlow *= 0.8 + br * 0.15; // very gentle breath modulation (no strobe)
  centerGlow += exp(-r * 7.0) * uVoiceEnergy * 0.2;
  vec3 glowColor = mix(uColor3, vec3(1.0), 0.6);

  // Blend: center pulls you in
  wallColor = mix(wallColor, glowColor, centerGlow);

  // ── Hypnotic pulse rings — avoid center to prevent strobe ──
  float pulseRingSpeed = 2.0 + uAudioBass * 3.0;
  float pulseRings = sin(r * 20.0 - uTime * pulseRingSpeed) * 0.5 + 0.5;
  // Start rings further from center (r * 3.0 falloff) so they don't flash at r≈0
  pulseRings *= exp(-r * 3.0) * (1.0 - exp(-r * 8.0)) * uIntensity * 0.18;
  pulseRings *= 1.0 + uAudioEnergy * 0.4;
  wallColor += uColor2 * pulseRings;

  // ── Chromatic aberration ──
  float aberration = uIntensity * 0.004;
  wallColor.r *= 1.0 + r * aberration * 8.0;
  wallColor.b *= 1.0 - r * aberration * 4.0;

  // ── Breath-sync interaction (applied to wall before vignette) ──
  if (uBreathSyncActive > 0.5) {
    float syncBandMask = exp(-pow((r - 0.18) / 0.12, 2.0));
    wallColor += uColor3 * syncBandMask * uBreathSyncFill * 0.4;
    wallColor *= 1.0 + uBreathSyncFill * br * 0.12;
    wallColor += uColor3 * syncBandMask * uBreathSyncProgress * 0.2;
  }

  // ── Darkness frame — always present, breathes noticeably ──
  // The screen edges open on inhale (lighter, warmer) and close on exhale
  // (darker, cooler). This is the primary subliminal breath indicator —
  // perceived in peripheral vision without competing with center text.
  float vrx = (vUv.x - 0.5) * aspect;
  float vry = vUv.y - 0.5;
  float vignR = length(vec2(vrx, vry)) * 2.0;

  // Inner edge breathes more prominently — opens on inhale, tightens on exhale
  float breathOpen = br * uBreathExpansion;
  float vigInner = 0.25 - uIntensity * 0.15 + breathOpen * 0.12;
  float vigOuter = 0.60 - uIntensity * 0.10 + breathOpen * 0.08;
  float vigDark = smoothstep(vigInner, vigOuter, vignR);
  vigDark = max(vigDark, 0.12);
  vigDark *= 0.5 + uIntensity * 0.45;

  // Darken walls toward black at edges
  wallColor *= 1.0 - vigDark;

  // ── Peripheral breath color — warm tint on inhale, cool on exhale ──
  // Only visible at the very edges, subliminal
  float edgeMask = smoothstep(0.5, 0.9, vignR); // only outer edges
  vec3 inhaleEdge = uColor3 * 0.15;   // warm accent
  vec3 exhaleEdge = uColor4 * 0.08;   // cool dark
  vec3 edgeTint = mix(exhaleEdge, inhaleEdge, br);
  wallColor += edgeTint * edgeMask * uBreathExpansion;

  // ── Overall intensity scaling (keep minimum brightness for tunnel feel) ──
  wallColor *= 0.6 + 0.4 * uIntensity;

  // ── Audio energy overall brightness boost ──
  wallColor *= 1.0 + uAudioEnergy * 0.2;

  // ── Ambient breathing warmth — very subtle, no flicker ──
  // Just a gentle overall warmth that shifts with breath, not a visible band
  vec3 breathTint = mix(uColor2 * 0.02, uColor3 * 0.04, br);
  wallColor += breathTint * uBreathExpansion;

  gl_FragColor = vec4(wallColor, 1.0);
}
