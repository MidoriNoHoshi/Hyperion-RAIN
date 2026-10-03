// rain.frag — a rainy windowpane laid over your desktop.
//
// Back to front:
//   graded veil -> light shafts -> bokeh city lights -> drifting mist
//   -> falling rain -> lightning -> condensation -> water on the glass
//
// gl-overlay convention: mainImage() writes *straight* RGBA, where alpha is
// how much of the effect covers the desktop. An overlay can't see the pixels
// beneath it, so drops are drawn as lenses with light and shadow only.
//
// Live-tune anything:  gl-overlay ctl set uRain 1.6
// Realistic only:      gl-overlay ctl set uDream 0

// --- weather
#pragma param uRain      1.0   // rain strength (0 dry .. 2 downpour)
#pragma param uVariation 0.7   // how much the strength drifts over time (0 = steady)
#pragma param uDrops     1.0   // water on the glass multiplier
#pragma param uStreaks   1.0   // falling rain multiplier
#pragma param uWind      0.12  // slant of the falling rain
#pragma param uSpeed     1.0   // time scale
#pragma param uScale     1.0   // drop size
#pragma param uMaxDrop   18.0  // largest drop radius, in screen pixels
#pragma param uFog       0.035 // condensation at the edges of the pane
#pragma param uTint      0.04  // overcast veil
#pragma param uLightning 0.0   // chance of lightning (0 .. 1)
// --- dream (all scaled by uDream)
#pragma param uDream     1.0   // master: 0 = realistic, 1 = dreamy, 2 = very
#pragma param uBokeh     1.0   // out-of-focus lights behind the glass
#pragma param uShafts    1.0   // light shafts, rain glitters inside them
#pragma param uPrism     1.0   // spectral fringe on drop edges
#pragma param uMist      1.0   // slow drifting haze low on the screen
#pragma param uDof       1.0   // some drops out of focus
#pragma param uGrade     1.0   // dusk colour grade
#pragma param uHue       0.0   // rotate the palette (0 .. 1)

uniform float uRain, uVariation, uDrops, uStreaks, uWind, uSpeed, uScale, uMaxDrop, uFog,
              uTint, uLightning, uDream, uBokeh, uShafts, uPrism, uMist, uDof,
              uGrade, uHue;

#define TAU 6.28318530718

// ---------------------------------------------------------------- utils
// sin-free hashes: stable across GPUs and at large inputs.
float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}
vec3 hash31(float p) {
    vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
}
vec3 hash32(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
}
float noise1(float x) {
    float i = floor(x), f = fract(x);
    return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}
// soft pastel palette, t in 0..1 walks amber -> rose -> violet -> teal
vec3 pal(float t) {
    return 0.62 + 0.38 * cos(TAU * (t + vec3(0.0, 0.18, 0.36)));
}

// Premultiplied "over": paint a layer on top of what's behind.
void over(inout vec4 acc, vec3 col, float a) {
    a = clamp(a, 0.0, 1.0);
    acc.rgb = col * a + acc.rgb * (1.0 - a);
    acc.a = a + acc.a * (1.0 - a);
}

// Storm intensity: drifts slowly through lulls and downpours.
float storm(float t) {
    float n = noise1(t / 45.0) * 0.6 + noise1(t / 14.0 + 5.0) * 0.3 + noise1(t / 4.0 + 9.0) * 0.1;
    return uRain * mix(1.0, 0.25 + 1.5 * smoothstep(0.2, 0.8, n), uVariation);
}

// ---------------------------------------------------------------- glass
struct Drop {
    vec2 d;      // position inside the drop, |d| = 1 at the rim
    float m;     // coverage
    float wipe;  // trail left by a running drop
    float blur;  // 0 = in focus
};

// Still beads: condense, sit, evaporate. Slightly irregular, mostly small.
Drop beads(vec2 uv, float t, float density, float px, float layer) {
    vec2 id = floor(uv);
    vec2 st = fract(uv) - 0.5;
    vec3 h = hash32(id + 17.0 + layer * 31.0);
    vec3 g = hash32(id * 1.7 + 5.0 + layer * 13.0);

    vec2 c = (h.xy - 0.5) * 0.5;
    float r = mix(0.05, 0.21, g.x * g.x);
    r = min(r, uMaxDrop * px * mix(0.8, 1.0, g.y));   // size cap, kept varied
    float life = fract(t * mix(0.015, 0.04, g.y) + h.x * 7.3);
    float fade = smoothstep(0.0, 0.12, life) * smoothstep(1.0, 0.6, life);
    r *= mix(0.5, 1.0, sqrt(fade));

    vec2 d = (st - c) / r;
    // irregular outline from the direction's 2nd/3rd harmonics (no atan)
    vec2 n = d / max(length(d), 1e-4);
    float c2 = n.x * n.x - n.y * n.y, s2 = 2.0 * n.x * n.y;
    float c3 = n.x * (4.0 * n.x * n.x - 3.0), s3 = n.y * (3.0 - 4.0 * n.y * n.y);
    vec2 r2 = vec2(cos(g.z * TAU), sin(g.z * TAU));
    d /= 1.0 + 0.07 * (c2 * r2.x + s2 * r2.y) + 0.04 * (c3 * r2.y + s3 * r2.x);
    d.y *= 1.06;

    float blur = min(uDof * uDream, 1.5) * 0.45 * smoothstep(0.75, 1.0, g.z);
    float aa = min(1.5 * px / r + blur, 0.9);
    float present = smoothstep(h.z, h.z + 0.1, density);
    float m = (1.0 - smoothstep(1.0 - aa, 1.0, length(d))) * fade * present * (1.0 - 0.5 * blur);
    return Drop(d, m, 0.0, blur);
}

float pathX(float y, vec3 h) {
    return 0.09 * sin(y * 1.7 + h.x * TAU) + 0.04 * sin(y * 4.3 + h.y * TAU);
}

// Running drops: hold, swell, dart down, leave a beaded wet trail.
Drop runner(vec2 uv, float t, float density, float px, float layer, float H) {
    float col = floor(uv.x);
    vec3 hc = hash31(col + 3.7 + layer * 17.0);
    vec2 id = vec2(col, floor(uv.y / H));
    vec3 h = hash32(id * vec2(1.0, 7.1) + 31.0 + layer * 5.0);
    vec2 p = vec2(fract(uv.x) - 0.5 - (hc.y - 0.5) * 0.3, mod(uv.y, H));

    float rate = mix(0.035, 0.08, h.y);
    float f = fract(t * rate + hc.z);
    float steps = 4.0 + floor(h.x * 5.0);
    float g = f * steps;
    float s = fract(g);
    float slip = (floor(g) + smoothstep(0.6, 1.0, s)) / steps;
    slip = mix(slip, f, 0.25);
    float yc = mix(H + 0.3, -0.5, slip);

    // swells while it clings, sheds water into the trail when it moves
    float swell = s < 0.6 ? s / 0.6 : 1.0 - (s - 0.6) / 0.4;
    float r = min(mix(0.11, 0.19, h.x), uMaxDrop * px * mix(0.8, 1.0, h.y))
            * mix(0.93, 1.07, swell);

    float hs = hash11(id.x * 13.1 + id.y * 3.7 + layer * 7.0);
    float alive = smoothstep(hs, hs + 0.1, density);

    vec2 c = vec2(pathX(yc, h), yc);
    vec2 d = (p - c) / r;
    d.y *= d.y > 0.0 ? 0.75 : 1.0;          // drawn out on top, round below
    float aa = 1.5 * px / r;
    float m = (1.0 - smoothstep(1.0 - aa, 1.0, length(d))) * alive;

    float above = p.y - yc;
    float trailLen = 1.8;
    float tfade = step(0.0, above) * smoothstep(trailLen, 0.0, above);
    float dx = p.x - pathX(p.y, h);
    float tw = r * mix(0.15, 0.45, tfade);
    float wipe = (1.0 - smoothstep(tw * 0.4, tw, abs(dx))) * tfade * alive;

    float spacing = 0.12;
    float by = (floor(p.y / spacing) + 0.5) * spacing;
    float bAbove = by - yc;
    float bfade = step(r * 1.5, bAbove) * smoothstep(trailLen, 0.2, bAbove);
    float bh = hash11(by * 17.0 + h.x * 91.0);
    float br = max(r * mix(0.15, 0.4, bh) * bfade * step(0.3, bh), 1e-4);
    vec2 bd = (p - vec2(pathX(by, h) + (bh - 0.5) * 0.06, by)) / br;
    float bm = (1.0 - smoothstep(1.0 - min(1.5 * px / br, 0.9), 1.0, length(bd)))
             * step(2e-4, br) * alive;

    return m >= bm ? Drop(d, m, wipe, 0.0) : Drop(bd, bm, wipe, 0.0);
}

Drop glass(vec2 uv, float t, float k, float px) {
    float s = uScale, w = uDrops * k;
    Drop r1 = runner(uv * 4.5 / s, t, 0.8 * w, px * 4.5 / s, 0.0, 4.5 / s + 1.0);
    Drop r2 = runner(uv * 6.5 / s + vec2(3.3, 0.0), t * 1.1, 0.7 * w, px * 6.5 / s, 1.0, 6.5 / s + 1.0);
    float wipe = max(r1.wipe, r2.wipe);

    Drop b1 = beads(uv * 13.0 / s, t, 0.5 * w, px * 13.0 / s, 0.0);
    Drop b2 = beads(uv * 27.0 / s + 7.7, t * 1.3, 0.5 * w, px * 27.0 / s, 1.0);
    Drop b3 = beads(uv * 58.0 / s + 3.1, t * 1.7, 0.75 * w, px * 58.0 / s, 2.0);
    b1.m *= 1.0 - wipe;
    b2.m *= 1.0 - wipe;
    b3.m *= (1.0 - wipe) * 0.7;              // fine mist: barely there

    Drop best = r1;
    if (r2.m > best.m) best = r2;
    if (b1.m > best.m) best = b1;
    if (b2.m > best.m) best = b2;
    if (b3.m > best.m) best = b3;
    best.wipe = wipe;
    return best;
}

// A drop is a tiny lens: it flips the scene, so the dark ground shows in
// its top half and bright sky pools along its bottom edge.
void shadeDrop(inout vec4 acc, Drop g, vec3 amb, float flash) {
    if (g.m < 0.002)
        return;
    vec2 d = g.d;
    float l = min(length(d), 1.0);
    float m = g.m, sharp = 1.0 - min(g.blur * 1.5, 1.0);

    over(acc, vec3(0.75, 0.8, 0.86), 0.035 * m);

    float top = smoothstep(-0.35, 0.85, d.y) * smoothstep(0.15, 0.9, l);
    over(acc, vec3(0.01, 0.015, 0.03), 0.26 * top * m * mix(0.5, 1.0, sharp));

    float bottom = smoothstep(0.15, -0.9, d.y) * smoothstep(0.3, 0.9, l) * (1.0 - smoothstep(0.9, 1.0, l));
    vec3 sky = mix(vec3(0.88, 0.93, 1.0), amb, 0.55 * min(uDream, 1.0));
    over(acc, sky, (0.3 + 0.5 * flash) * bottom * m);

    float edge = smoothstep(0.78, 0.95, l);
    over(acc, vec3(0.0, 0.01, 0.02), 0.2 * edge * m * sharp);

    float band = smoothstep(0.7, 0.86, l) * (1.0 - smoothstep(0.9, 1.0, l));
    vec3 spectrum = 0.5 + 0.5 * cos(TAU * (l * 2.5 + d.y * 0.3 - 0.6 + vec3(0.0, 0.33, 0.67)));
    over(acc, spectrum, band * 0.08 * uPrism * min(uDream, 1.5) * m);

    vec2 sp = (d - vec2(-0.3, 0.42)) * vec2(1.0, 1.6);
    float glint = 1.0 - smoothstep(0.06, 0.18 + g.blur * 0.4, length(sp));
    float halo = (1.0 - smoothstep(0.0, 0.55, length(sp))) * 0.12 * uDream;
    float glint2 = (1.0 - smoothstep(0.0, 0.22, length((d - vec2(0.28, -0.6)) * vec2(1.0, 2.4)))) * 0.3;
    over(acc, vec3(1.0), (glint * 0.9 + halo + glint2) * m);
}

// ---------------------------------------------------------------- outside
// One parallax layer of falling streaks seen through the glass.
float rainLayer(vec2 uv, float t, float cols, float speed, float len, float px,
                float k, float blur) {
    uv.x += uv.y * uWind;
    vec2 p = uv * cols;
    float col = floor(p.x);
    vec3 h = hash31(col * 1.37 + cols);

    float x = fract(p.x) - 0.5 - (h.x - 0.5) * 0.7;
    float w = (1.0 + blur) * px * cols;
    float line = (1.0 - smoothstep(0.0, 1.2 * w, abs(x))) / (1.0 + 0.6 * blur);

    float phase = (uv.y + t * speed * mix(0.85, 1.15, h.y)) * 1.6 + h.z * 9.0;
    float seg = fract(phase), sid = floor(phase);
    float l = len * mix(0.6, 1.4, hash11(sid * 3.1 + col));
    float streak = smoothstep(l, 0.0, seg) * smoothstep(0.0, 0.006, seg);

    float hs = hash11(col * 7.31 + sid * 1.7);
    float on = smoothstep(hs, hs + 0.12, 0.42 * k);
    return line * streak * on * mix(0.45, 1.0, hash11(sid + col * 0.31));
}

// Out-of-focus lights far behind the glass: soft discs with a brighter rim.
// One light per cell keeps this to a single lookup per layer.
vec4 bokeh(vec2 uv, float t, float cells, float seed) {
    vec2 p = uv * cells + vec2(t * 0.02, sin(t * 0.03) * 0.3);
    vec2 id = floor(p);
    vec3 h = hash32(id + seed);
    vec2 c = id + 0.5 + (h.xy - 0.5) * 0.2;
    float r = mix(0.2, 0.4, hash11(h.x * 71.0 + seed));
    float dd = length(p - c) / r;
    if (h.z > 0.5 || dd >= 1.0)
        return vec4(0.0);
    float soft = 0.06 + 0.2 * h.y;
    float disc = 1.0 - smoothstep(1.0 - soft, 1.0, dd);
    float ring = smoothstep(0.55, 0.96, dd) * disc;
    float breathe = 0.55 + 0.45 * sin(t * (0.15 + 0.4 * h.x) + h.y * TAU);
    float a = (disc * 0.5 + ring * 0.5) * breathe;
    return vec4(pal(h.x * 0.55 + uHue + seed * 0.07) * a, a);
}

// Crepuscular rays falling from beyond the top-left corner.
float shafts(vec2 uv, float aspect, float t) {
    vec2 v = uv - vec2(0.15 * aspect, 1.25);
    float ang = atan(v.x, -v.y);
    float rays = noise1(ang * 16.0 + t * 0.04) * 0.6 + noise1(ang * 37.0 - t * 0.07) * 0.4;
    rays = smoothstep(0.4, 1.0, rays);
    float cone = smoothstep(1.1, 0.35, abs(ang - 0.45));
    return rays * cone * exp(-length(v) * 0.8);
}

// ---------------------------------------------------------------- main
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.y;    // aspect-correct, 1 = screen height
    vec2 q = fragCoord / iResolution.xy;    // 0..1 across the screen
    float aspect = iResolution.x / iResolution.y;
    float px = 1.0 / iResolution.y;
    float t = iTime * uSpeed;
    float k = storm(t);
    float dream = uDream;
    vec3 amb = pal(uHue + t * 0.006);
    vec4 acc = vec4(0.0);

    // graded veil: overcast grey, or dusk blue -> violet when dreaming
    float vig = smoothstep(0.3, 0.95, length(q - 0.5) * 1.3);
    vec3 veil = mix(vec3(0.08, 0.1, 0.13),
                    mix(vec3(0.16, 0.08, 0.2), vec3(0.06, 0.1, 0.2), q.y),
                    min(uGrade * dream, 1.0));
    over(acc, veil, uTint * (0.6 + 0.4 * k) * (1.0 + vig) + 0.05 * uGrade * dream * (0.4 + vig));

    // dream layers are skipped entirely when switched off (uniform branches)
    float shaft = 0.0;
    if (uShafts * dream > 0.0) {
        shaft = shafts(uv, aspect, t) * uShafts * dream;
        over(acc, mix(vec3(1.0, 0.95, 0.85), amb, 0.4), 0.07 * shaft);
    }

    if (uBokeh * dream > 0.0) {
        // bokeh sits low, like distant street lights
        vec4 bk = bokeh(uv, t, 5.0, 0.0) + bokeh(uv * 0.8 + 4.0, t * 0.7, 7.0, 9.0) * 0.6;
        float low = mix(0.25, 1.0, smoothstep(0.85, 0.15, q.y));
        over(acc, bk.rgb / max(bk.a, 1e-4), min(bk.a, 1.0) * 0.1 * low * uBokeh * dream);
    }

    if (uMist * dream > 0.0) {
        float mist = texture(iChannel1, vec2(uv.x * 0.05 + t * 0.004, uv.y * 0.12)).r * 0.6
                   + texture(iChannel1, uv * vec2(0.13, 0.3) + vec2(-t * 0.007, 0.0)).g * 0.4;
        mist = smoothstep(0.35, 0.9, mist) * smoothstep(0.8, 0.0, q.y);
        over(acc, mix(vec3(0.75, 0.8, 0.9), amb, 0.4), mist * 0.06 * uMist * dream);
    }

    float rain = rainLayer(uv, t, 110.0, 1.3, 0.10, px, k, 0.0) * 0.3
               + rainLayer(uv + 3.1, t, 55.0, 1.8, 0.14, px, k, 0.0) * 0.5
               + rainLayer(uv + 7.9, t, 24.0, 2.6, 0.2, px, k, 1.5 * dream) * 0.75;
    float glitter = 1.0 + 4.0 * shaft;
    over(acc, mix(vec3(0.78, 0.84, 0.95), vec3(1.0, 0.96, 0.9), min(shaft * 3.0, 1.0)),
         rain * 0.28 * uStreaks * glitter);

    float win = floor(t / 7.0);
    vec3 lh = hash31(win + 0.5);
    float lt = fract(t / 7.0) * 7.0 - lh.y * 5.0;
    float flash = step(lh.x, uLightning * 0.6 * min(k, 1.5)) * step(0.0, lt)
                * (exp(-lt * 7.0) + 0.6 * exp(-max(lt - 0.18, 0.0) * 9.0) * step(0.18, lt));
    over(acc, vec3(0.86, 0.9, 1.0), flash * 0.35);

    Drop g = glass(uv, t, k, px);

    // condensation: faint, low-frequency, hugging the frame of the pane
    float n = texture(iChannel0, uv * 0.03 + vec2(t * 0.001, 0.0)).r * 0.65
            + texture(iChannel0, uv * 0.09).g * 0.35;
    float frame = smoothstep(0.3, 0.75, length((q - 0.5) * vec2(1.0, 1.15)));
    float fog = uFog * smoothstep(0.3, 0.8, n) * mix(0.25, 1.0, frame) * (0.6 + 0.4 * k);
    over(acc, vec3(0.8, 0.84, 0.88), fog * (1.0 - g.wipe) * (1.0 - g.m));

    // wet trail: a slightly darker channel with faint bright edges
    float trailEdge = g.wipe * (1.0 - g.wipe) * 4.0;
    over(acc, vec3(0.02, 0.03, 0.05), 0.07 * g.wipe * (1.0 - g.m));
    over(acc, vec3(0.85, 0.9, 1.0), 0.045 * trailEdge * (1.0 - g.m));
    shadeDrop(acc, g, amb, flash);

    fragColor = vec4(acc.rgb / max(acc.a, 1e-4), acc.a);
}
