// WMP-style tunnel — polar coordinate warp, rings flowing toward you
// No raymarching needed — pure 2D math, extremely fast

uniform float uTime;
uniform float uIntensity;
uniform vec2 uMouse;
uniform float uBreathePhase;
uniform float uBreathValue;  // 0-1 direct from BreathController (supports holds)
uniform float uBreathStage;  // 0=inhale, 1=hold-in, 2=exhale, 3=hold-out
uniform float uSpiralSpeed;
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

  // ── Tunnel path — curves simulated via rotation + asymmetric shading ──
  // Center stays fixed, but the tunnel FEELS like it's curving
  float pathTime = uTime * 0.15;
  vec2 curveDir = vec2(
    sin(pathTime * 1.0) + sin(pathTime * 2.3) * 0.5,
    cos(pathTime * 0.7) + sin(pathTime * 1.8) * 0.4
  );
  // Normalize and scale by intensity (more curves when deeper)
  float curveMag = length(curveDir);
  curveDir = curveMag > 0.01 ? curveDir / curveMag : vec2(0.0);
  float curveAmount = min(curveMag * 0.15, 0.15) * (0.3 + uIntensity * 0.7);

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

  // ── Tube bulge — the tunnel widens/narrows at a mid-section ──
  // Like a tube that breathes — a physical expansion at the breathing band
  float bulgeCenter = 0.22; // radial position of the bulge (matches glow band)
  float bulgeFalloff = exp(-pow((r - bulgeCenter) / 0.18, 2.0));
  float bulgeAmount = (br - 0.5) * 0.15 * uBreathExpansion; // inhale pushes walls out
  float bulgedR = r - bulgeFalloff * bulgeAmount; // displace inward = tunnel wider there

  // ── Tunnel depth mapping ──
  float scaledR = bulgedR / uTunnelWidth;
  float depth = 0.4 / (max(scaledR, 0.01) + 0.05);

  // Subtle back-and-forth with breath
  float breathDepth = (br - 0.5) * 0.2 * uBreathExpansion;
  depth += breathDepth;

  // Forward movement — constant base speed
  float z = depth + uTime * 0.6 * uTunnelSpeed;

  // ── Tunnel texture coordinates ──
  // Angle gives us "around the tube", depth gives us "along the tube"
  float texU = angle / TAU + 0.5; // 0-1 around
  float texV = z; // along the tunnel

  // ── Spiral twist — uses raw depth (pre-bulge) so breathing doesn't cause spin bursts ──
  float rawDepth = 0.4 / (r / uTunnelWidth + 0.05);
  float twist = uTime * uSpiralSpeed * 0.5 + rawDepth * 0.8 * uIntensity;
  float twistedAngle = angle + twist;
  float texUTwisted = twistedAngle / TAU + 0.5;

  // ── Ring segments — organic mode makes these softer, like ridges ──
  float ringFreq = mix(12.0, 6.0, uTunnelShape); // fewer, broader ridges when organic
  float rings = sin(z * ringFreq) * 0.5 + 0.5;
  float ringSharpLo = mix(0.3, 0.15, uTunnelShape);
  float ringSharpHi = mix(0.7, 0.85, uTunnelShape);
  rings = smoothstep(ringSharpLo, ringSharpHi, rings);

  // Bass makes rings pulse
  float ringPulse = 1.0 + uAudioBass * 0.4;
  rings *= ringPulse;

  // ── Segment lines — organic mode reduces/removes geometric segments ──
  float segments = mix(8.0 + uIntensity * 8.0, 3.0, uTunnelShape);
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

  // Ring highlights — bright accent color on ring edges
  vec3 ringColor = uColor3 * 1.5;
  ringColor += uColor2 * uAudioHigh * 0.5; // high freq brightens rings
  wallColor = mix(wallColor, ringColor, rings * 0.4 * uIntensity);

  // Segment lines — subtle geometric structure
  wallColor += uColor3 * segLines * 0.3 * uIntensity;

  // Wall noise organic variation
  wallColor *= 1.0 + wallNoise;

  // Voice energy warms walls when narrator speaks
  wallColor += uColor3 * uVoiceEnergy * 0.15;

  // ── Depth shading — edges (close to viewer) slightly darker ──
  float depthShade = smoothstep(0.0, 1.5, depth);
  wallColor *= 0.5 + 0.5 * depthShade;

  // ── Curve shading — asymmetric brightness sells the turning illusion ──
  // The side we're "turning toward" gets brighter (wall appears closer)
  float curveDot = dot(normalize(uv + 0.001), curveDir);
  float curveShade = 1.0 + curveDot * curveAmount * 0.6;
  wallColor *= curveShade;

  // ── Fog — subtle fade at extreme depth ──
  float fog = exp(-depth * 0.08);
  wallColor = mix(wallColor, uColor4 * 0.3, 1.0 - fog);

  // ── Center glow — bright light at the end of the tunnel ──
  // This is computed separately and blended over everything
  float centerFalloff = exp(-r * 3.5);
  float centerGlow = centerFalloff * (0.8 + uIntensity * 0.2);
  centerGlow *= 0.7 + br * 0.3;
  centerGlow += exp(-r * 6.0) * uVoiceEnergy * 0.3;
  vec3 glowColor = mix(uColor3, vec3(1.0), 0.7);

  // Blend: at center (r→0), glow dominates; at edges, walls dominate
  wallColor = mix(wallColor, glowColor, centerGlow);

  // ── Pulsing rings emanating from center — audio reactive ──
  float pulseRingSpeed = 3.0 + uAudioBass * 4.0;
  float pulseRings = sin(r * 25.0 - uTime * pulseRingSpeed) * 0.5 + 0.5;
  pulseRings *= exp(-r * 2.5) * uIntensity * 0.15;
  pulseRings *= 1.0 + uAudioEnergy * 0.5;
  wallColor += uColor2 * pulseRings;

  // ── Chromatic aberration ──
  float aberration = uIntensity * 0.004;
  wallColor.r *= 1.0 + r * aberration * 8.0;
  wallColor.b *= 1.0 - r * aberration * 4.0;

  // ── Breathing glow band — stays in place, width pulses ──
  // Fixed center position — the band doesn't move, it breathes in place
  float bandCenter = 0.22;
  // Fixed width band — color shifts with breath instead of going dark
  float bandWidth = 0.1;
  float bandMask = exp(-pow((r - bandCenter) / bandWidth, 2.0));

  // Each breath phase has its own color signature
  vec3 inhaleCol = uColor3 * 1.2;                       // bright accent — expanding
  vec3 holdInCol = mix(uColor3, vec3(1.0), 0.3);        // warm white — held open
  vec3 exhaleCol = uColor2 * 0.9;                       // secondary — releasing
  vec3 holdOutCol = mix(uColor1, uColor4, 0.3) * 0.8;   // deep primary — stillness

  // Blend between stages smoothly using breath value as interpolant
  vec3 bandColor;
  if (uBreathStage < 0.5) {
    bandColor = mix(exhaleCol, inhaleCol, br);       // inhaling
  } else if (uBreathStage < 1.5) {
    bandColor = holdInCol;                            // holding full
  } else if (uBreathStage < 2.5) {
    bandColor = mix(inhaleCol, exhaleCol, 1.0 - br); // exhaling
  } else {
    bandColor = holdOutCol;                           // holding empty
  }

  float bandStrength = 0.2 + br * 0.08 * uBreathExpansion;
  wallColor += bandColor * bandMask * bandStrength;

  // ── Breath-sync interaction — enhances the breathing band ──
  if (uBreathSyncActive > 0.5) {
    // When in sync, the band glows much brighter
    wallColor += uColor3 * bandMask * uBreathSyncFill * 0.5;
    // Whole tunnel subtly brightens when synced
    wallColor *= 1.0 + uBreathSyncFill * br * 0.15;
    // Progress makes the band permanently brighter
    wallColor += uColor3 * bandMask * uBreathSyncProgress * 0.3;
  }

  // ── Darkness frame — always present, breathes slightly ──
  // The darkness never fully retreats — it frames the experience
  float vrx = (vUv.x - 0.5) * aspect;
  float vry = vUv.y - 0.5;
  float vignR = length(vec2(vrx, vry)) * 2.0;

  // Inner edge breathes slightly — opens a little on inhale, closes on exhale
  // But always stays as a visible dark frame
  float vigInner = 0.28 - uIntensity * 0.15 + br * 0.05 * uBreathExpansion;
  float vigOuter = 0.65 - uIntensity * 0.10 + br * 0.03 * uBreathExpansion;
  float vigDark = smoothstep(vigInner, vigOuter, vignR);
  vigDark = max(vigDark, 0.15); // darkness never fully disappears
  vigDark *= 0.5 + uIntensity * 0.45;

  // Darken walls toward black at edges — feels like the tunnel itself narrows
  wallColor *= 1.0 - vigDark;

  // ── Overall intensity scaling (keep minimum brightness for tunnel feel) ──
  wallColor *= 0.6 + 0.4 * uIntensity;

  // ── Audio energy overall brightness boost ──
  wallColor *= 1.0 + uAudioEnergy * 0.2;

  gl_FragColor = vec4(wallColor, 1.0);
}
