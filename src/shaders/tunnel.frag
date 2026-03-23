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
uniform vec3  uPresencePos;  // world position of the presence wisp
uniform vec3  uPortalColor1; // session preview: primary (deep side of portal)
uniform vec3  uPortalColor2; // session preview: secondary
uniform float uPortalBlend;  // 0 = no portal, 1 = fully showing session colors

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

  float br = uBreathValue;

  // ────────────────────────────────────────────────────────────
  // 1. POLAR COORDINATES
  // ────────────────────────────────────────────────────────────
  // Mouse adds subtle offset
  uv += uMouse * 0.04 * uIntensity;

  // For the radius (depth mapping), use screen-proportional distance
  // so the tunnel fills the screen as a circle matching the SHORTER axis.
  // This prevents the oval appearance on widescreen.
  float r     = length(uv) * 2.0; // 0 at center, ~1 at edges (short axis)

  // For the angle (twist, texture U), use aspect-corrected coords
  // so the angular texture isn't squished
  vec2 uvAspect = vec2(uv.x * aspect, uv.y);
  float angle = atan(uvAspect.y, uvAspect.x);

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
    r += uvAspect.x * sin(t * 0.1) * 0.02 * org
       + uvAspect.y * cos(t * 0.13) * 0.015 * org;
    // Warm throb
    r *= 1.0 - (sin(t * 0.7) * 0.5 + 0.5) * 0.03 * org;
  }

  // ────────────────────────────────────────────────────────────
  // 2. DEPTH MAPPING
  // ────────────────────────────────────────────────────────────
  // Classic tunnel: depth = 1/r
  float sr    = r / uTunnelWidth;
  float depth = 0.5 / (max(sr, 0.01) + 0.03);

  // Multi-timescale: tunnel's own slow rhythm
  depth += sin(uTime * 0.25) * 0.012;  // ~25s
  depth += sin(uTime * 0.07) * 0.006;  // ~90s glacial

  // Scrolling forward
  float z = depth + uTime * 0.6 * uTunnelSpeed;

  // ────────────────────────────────────────────────────────────
  // 3. TEXTURE COORDINATES + PARALLAX
  // ────────────────────────────────────────────────────────────
  float rawDepth     = 0.4 / (r / uTunnelWidth + 0.05);
  float twist        = uSpiralAngle + rawDepth * 0.3;
  float twistedAngle = angle + twist;
  float texU         = twistedAngle / TAU + 0.5; // around tube
  float texV         = z;                         // along tube

  // Parallax disabled — was causing oval distortion of rings
  // (uv.x is aspect-corrected but uv.y isn't, making shifts asymmetric)
  float parallaxStrength = 0.0;
  float depthFactor = 1.0 / (1.0 + rawDepth * 0.5);

  // ────────────────────────────────────────────────────────────
  // 4. WALL TEXTURE — solid ridged walls with light/shadow
  // ────────────────────────────────────────────────────────────
  // Primary rings — depth ridges (the spiral twist comes from uSpiralAngle via texU)
  float ringFreq = mix(14.0, 7.0, uTunnelShape);
  float ringRaw  = sin(texV * ringFreq);
  float rings    = ringRaw * 0.5 + 0.5;
  rings = smoothstep(
    mix(0.25, 0.10, uTunnelShape),
    mix(0.65, 0.80, uTunnelShape),
    rings
  );
  rings *= 1.0 + uAudioBass * 0.4;

  // Secondary rings — finer detail between primary ridges
  float fineRings = sin(texV * ringFreq * 3.0 + 0.5) * 0.5 + 0.5;
  fineRings = smoothstep(0.3, 0.7, fineRings) * 0.3;

  // Ridge edge highlight — light catching the edge of each ring
  float ringEdge = abs(ringRaw);
  ringEdge = 1.0 - smoothstep(0.0, 0.3, ringEdge);
  ringEdge *= 0.4;

  // Segment lines — radial structural ribs
  float segCount = mix(12.0, 3.0, uTunnelShape);
  float segLines = abs(sin(twistedAngle * segCount));
  segLines = smoothstep(mix(0.92, 0.98, uTunnelShape), 0.99, segLines);
  segLines *= 1.0 - uTunnelShape * 0.7;

  // Flowing patterns
  float pat1 = sin(texU * TAU * 3.0 + texV * 2.0) * 0.5 + 0.5;
  float pat2 = sin(texU * TAU * 5.0 - texV * 1.5 + uTime * 0.5) * 0.5 + 0.5;

  // Wall grain — noise that follows the surface (not just random)
  float nScale   = mix(0.3, 0.7, uTunnelShape);
  float wallNois = noise(vec2(twistedAngle * 3.0, texV * 1.5)) * nScale * uIntensity * 0.6
                 + noise(vec2(angle * 4.0 + uTime * 0.1, texV * 0.3)) * 0.15 * uTunnelShape;

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

  // Ring grooves — deep shadow between ridges for solid carved-stone feel
  float groove = 0.45 + rings * 0.55;
  groove -= (1.0 - rings) * fineRings * 0.2; // fine detail darkens the valleys further
  wall *= groove;

  // Ring highlights — bright ridge tops
  vec3 ringCol = uColor3 * 1.6 + uColor2 * uAudioHigh * 0.4;
  wall = mix(wall, ringCol, rings * 0.5 * uIntensity);

  // Edge specular — light catching the ridge edges (ethereal glow on ridges)
  wall += (uColor3 * 0.8 + vec3(0.15)) * ringEdge * uIntensity;

  // Segment lines — structural ribs
  wall += uColor3 * segLines * 0.35 * uIntensity;

  // Deep layer — a second texture at a different parallax depth
  // Creates the illusion of wall thickness (foreground ridges over background grain)
  float deepTexV = texV + uv.y * parallaxStrength * depthFactor * 2.0;
  float deepPat = sin(deepTexV * ringFreq * 0.5 + twistedAngle * 2.0) * 0.5 + 0.5;
  deepPat = smoothstep(0.3, 0.7, deepPat);
  wall = mix(wall, wall * 0.7, deepPat * 0.15 * (1.0 - rings)); // visible mainly in grooves

  // Wall grain — subtle texture variation
  wall *= 1.0 + wallNois;

  // Energy shimmer — bright specks drifting along the ridges (replaces particles)
  float shimmerCoord1 = noise(vec2(twistedAngle * 5.0 + uTime * 0.3, texV * 3.0 - uTime * 0.8));
  float shimmerCoord2 = noise(vec2(-twistedAngle * 7.0 + uTime * 0.2 + 3.0, texV * 4.0 + uTime * 0.5));
  float shimmer1 = pow(shimmerCoord1, 6.0); // sharpen into rare bright specks
  float shimmer2 = pow(shimmerCoord2, 7.0);
  float wallShimmer = (shimmer1 + shimmer2 * 0.7) * rings * 0.4 * uIntensity;
  wall += (uColor3 * 0.6 + uColor2 * 0.4) * wallShimmer;

  // Voice warmth
  wall += uColor3 * uVoiceEnergy * 0.12;

  // ────────────────────────────────────────────────────────────
  // 6. LIGHTING — one unified pass
  // ────────────────────────────────────────────────────────────
  // a) Cylindrical shading: strong top/bottom darkening for tube roundness
  float cylLight = 0.6 + 0.4 * cos(angle - PI * 0.5);

  // b) Depth gradient: near walls bright, far walls dim
  float depthLight = 0.15 + 0.85 * smoothstep(0.0, 1.8, depth);

  // c-extra) Ambient occlusion — walls at the edges of screen are darker
  // (light can't reach deep into the tube periphery)
  float ao = 0.7 + 0.3 * smoothstep(0.5, 0.15, r);

  // c) Curve shading: turning illusion
  vec2 curveDir = vec2(
    sin(uTime * 0.08) + sin(uTime * 0.184) * 0.3,
    cos(uTime * 0.056) + sin(uTime * 0.144) * 0.25
  );
  float cLen = length(curveDir);
  curveDir = cLen > 0.01 ? curveDir / cLen : vec2(0.0);
  float curveLight = 1.0 + dot(normalize(uv + 0.001), curveDir) * min(cLen * 0.08, 0.08) * 0.5;

  // d) Depth fog: faster falloff to black — less haze, more solid near walls
  float fogMix = 1.0 - exp(-depth * 0.15);

  // Apply lighting in one multiply — AO darkens edges for tangible depth
  wall *= cylLight * depthLight * curveLight * ao;

  // Fog blends toward deep, dark color — gives infinite depth feeling
  wall = mix(wall, uColor4 * 0.15, fogMix);

  // ────────────────────────────────────────────────────────────
  // 7. CENTER GLOW — the hypnotic attractor
  // ────────────────────────────────────────────────────────────
  // Center glow — reduced so tunnel walls stay dark near the wisp (contrast)
  float centerFall = exp(-r * 5.0);
  float glow       = centerFall * (0.5 + uIntensity * 0.15) * (0.85 + br * 0.15);
  glow += exp(-r * 8.0) * uVoiceEnergy * 0.15;
  vec3 glowCol = mix(uColor3, vec3(1.0), 0.45);
  wall = mix(wall, glowCol, glow * 0.7);

  // ── Presence light ring — the wisp illuminates the tunnel wall around it ──
  // The presence sits near r≈0 at a certain tunnel depth. Its light hits the
  // walls at the periphery, creating a bright ring at a specific radius.
  // This radius breathes with the presence.
  // ── Presence glow ring — driven by the wisp's actual screen position ──
  // The presence is a 2D sprite at some z-depth. In the tunnel's polar coords,
  // the presence center appears at r≈0 (screen center). Its "depth ring" is the
  // ring of wall texture at the tunnel-depth corresponding to its z-position.
  // Invert the depth formula: depth = 0.5/(sr+0.03), so sr = 0.5/depth - 0.03
  // → r = sr * tunnelWidth.  But depth scrolls with time, so we match texV instead.
  //
  // Simpler: the presence's z maps to a screen-radius where the tunnel wall
  // would be at that depth. Use: r_wall ≈ tunnelWidth * 0.5 / (-presenceZ)
  // Presence glow ring — uses a fixed screen-space radius driven by presence Z.
  // The ring sits at the tunnel wall radius where the presence depth is.
  // The wisp visually sits deep in the tunnel center. The ring should
  // illuminate the wall a few ridges out from where the wisp appears.
  // Scale: smaller wallR = deeper into the tunnel.
  float presenceDepth = max(-uPresencePos.z, 0.5);
  float wallR = uTunnelWidth * 0.16 / presenceDepth;
  float ringDist = abs(r - wallR);

  // Single tunnel wall ring — one bright ridge at the wisp's depth
  float glowWidth = max(wallR * 0.08, 0.005);
  float presenceGlow = exp(-ringDist * ringDist / (glowWidth * glowWidth));
  presenceGlow *= 0.5 * (0.7 + br * 0.3);

  vec3 ringTint = mix(uColor3, vec3(1.0), 0.55);
  wall += ringTint * min(presenceGlow, 0.45) * rings;

  // ────────────────────────────────────────────────────────────
  // 8. PORTAL — session preview beyond the presence depth
  // ────────────────────────────────────────────────────────────
  // Everything deeper than the wisp (smaller r) shifts toward session colors.
  // Creates the feeling of peeking through a portal into another world.
  if (uPortalBlend > 0.01) {
    // How deep past the ring are we? 0 = at the ring, 1 = deep inside
    float portalDepth = smoothstep(wallR, wallR * 0.3, r); // 1.0 at center, 0 at ring
    float portalMask = portalDepth * uPortalBlend;

    // Blend wall color toward session palette (only the deep side)
    vec3 portalWall = mix(uPortalColor1, uPortalColor2, rings);
    // Match the existing wall brightness so it's a color shift, not a brightness change
    float wallLum = dot(wall, vec3(0.299, 0.587, 0.114));
    float portalLum = dot(portalWall, vec3(0.299, 0.587, 0.114));
    portalWall *= wallLum / max(portalLum, 0.01);

    wall = mix(wall, portalWall, portalMask * 0.7);
  }

  // ────────────────────────────────────────────────────────────
  // 9. CHROMATIC ABERRATION
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
  // Vignette distance — blend circular (tunnel-shaped) with rectangular (screen-shaped)
  // so the darkening follows the screen edges, not a circle that clips top/bottom
  vec2 vigUv = abs(vUv - 0.5) * 2.0; // 0 at center, 1 at edges
  float vrCircle = length(vec2(vigUv.x * aspect, vigUv.y));
  float vrScreen = max(vigUv.x, vigUv.y); // follows screen edges
  float vr = mix(vrCircle, vrScreen, 0.4);
  float fogRadial = smoothstep(0.15, 0.8, vr);
  float brFogMod  = 0.85 + (1.0 - br) * 0.15;
  // Atmospheric fog — extremely subtle, just breaks perfect uniformity
  float fogFar  = noise(uv * 1.5 + vec2(uTime * 0.02, uTime * 0.015));
  vec3 fogAccum = uColor4 * smoothstep(0.5, 0.75, fogFar) * 0.005;
  wall += fogAccum * fogRadial * brFogMod * uIntensity;

  // ────────────────────────────────────────────────────────────
  // 11. VIGNETTE — peripheral darkness for relaxed viewing
  // ────────────────────────────────────────────────────────────
  // The last few cm of screen fade to black following the tunnel shape.
  // This relaxes peripheral vision and frames the experience.

  float breathOpen = br * uBreathExpansion;
  float vigInner   = 0.22 - uIntensity * 0.10 + breathOpen * 0.08;
  float vigOuter   = 0.55 - uIntensity * 0.06 + breathOpen * 0.05;
  float vig        = smoothstep(vigInner, vigOuter, vr);
  vig = max(vig, 0.15); // stronger minimum darkness at edges
  vig *= 0.6 + uIntensity * 0.4;
  wall *= 1.0 - vig;

  // Hard edge fade — the very outermost pixels go fully black
  float hardEdge = smoothstep(0.85, 1.0, vr);
  wall *= 1.0 - hardEdge * 0.9;

  // ────────────────────────────────────────────────────────────
  // 11. FINAL
  // ────────────────────────────────────────────────────────────
  wall *= 0.6 + 0.4 * uIntensity;
  wall *= 1.0 + uAudioEnergy * 0.15;
  wall += mix(uColor2 * 0.015, uColor3 * 0.03, br) * uBreathExpansion;

  gl_FragColor = vec4(clamp(wall, 0.0, 1.0), 1.0);
}
