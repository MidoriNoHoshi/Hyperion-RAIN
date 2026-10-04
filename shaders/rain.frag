// rain.frag — a rainy windowpane laid over your desktop.
//
// Back to front:
//   graded veil -> light shafts -> bokeh city lights -> drifting mist
//   -> falling rain -> splashes on the ground -> lightning -> condensation
//   -> water on the glass
//
// gl-overlay convention: mainImage() writes *straight* RGBA, where alpha is
// how much of the effect covers the desktop. An overlay can't see the pixels
// beneath it, so drops are drawn as lenses with light and shadow only.
//
// Live-tune anything:  gl-overlay ctl set uRain 1.6
// Realistic only:      gl-overlay ctl set uDream 0
//
#pragma sound rain uRain   // default soundtrack (sounds/rain.ogg), loudness follows uRain

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
#pragma param uSplash    1.0   // drops splatter when they hit the glass
#pragma param uGround    1.0   // rain splashing on the ground along the bottom edge
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
              uTint, uLightning, uSplash, uGround, uDream, uBokeh, uShafts, uPrism, uMist, uDof,
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
// value noise that repeats every N, for angles
float noiseN(float x, float N, float seed) {
    float i = floor(x), f = fract(x);
    return mix(hash11(mod(i, N) + seed), hash11(mod(i + 1.0, N) + seed), f * f * (3.0 - 2.0 * f));
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
// The water on the pane is a height field: every drop is a shallow cap and a
// runner's trail is a thin film. Shading reads only the slope of that surface,
// so the light, the dark rim and the glint all follow each drop's real shape.
// Heights are signed (a cap keeps falling below zero just outside its rim), so
// drops that sit close together can melt into one blob instead of overlapping.
struct Water {
    float h;     // height of the water surface, screen units (< 0 = dry)
    vec2 g;      // its slope
    float aa;    // edge softness, screen units
    float blur;  // 0 = in focus
    float m;     // coverage, filled in at the end of glass()
};

const float CAP = 0.55;   // height / radius of a drop: rim slope 1.1, a ~48° contact angle

Water dry() { return Water(-1.0, vec2(0.0), 0.0, 0.0, 0.0); }

// Put a piece of water on the pane. k > 0 is a smooth union of that width:
// near neighbours pull together and bridge, like real drops coalescing.
void putWater(inout Water w, float h, vec2 g, float aa, float blur, float k) {
    if (k > 0.0) {
        float s = clamp(0.5 + 0.5 * (h - w.h) / k, 0.0, 1.0);
        w.h = mix(w.h, h, s) + k * s * (1.0 - s);
        w.g = mix(w.g, g, s);
        w.aa = mix(w.aa, aa, s);
        w.blur = mix(w.blur, blur, s);
    } else if (h > w.h) {
        w.h = h;
        w.g = g;
        w.aa = aa;
        w.blur = blur;
    }
}

// One drop, centre c and radius r in layer units; inv converts layer units to
// screen units so drops from different layers stack by real height.
// rag pushes the outline out (> 0) or in, e.g. into the fingers of a fresh splat.
void addDrop(inout Water w, vec2 p, vec2 c, float r, float px, float blur, float up,
             float seed, float inv, float rag, float k) {
    vec2 d = (p - c) / r;
    if (dot(d, d) > 2.2)
        return;
    vec3 hh = hash31(seed);
    d.x *= mix(0.88, 1.12, hh.z);                  // no two drops quite the same shape
    d.y *= d.y < 0.0 ? 1.1 : 0.94 * up;            // gravity: fuller, flatter bottom
    // irregular outline from the direction's 2nd/3rd harmonics (no atan);
    // big drops wobble more, like water that pinned on dirt as it spread
    vec2 n = d / max(length(d), 1e-4);
    vec2 rot = vec2(cos(hh.x * TAU), sin(hh.x * TAU));
    n = vec2(n.x * rot.x - n.y * rot.y, n.x * rot.y + n.y * rot.x);
    float c2 = n.x * n.x - n.y * n.y;
    float c3 = n.x * (4.0 * n.x * n.x - 3.0), s3 = n.y * (3.0 - 4.0 * n.y * n.y);
    float wob = mix(0.03, 0.12, hh.y) * smoothstep(2.0, 12.0, r / px);
    float edge = wob * (c2 + 0.6 * mix(c3, s3, hh.z)) + rag;
    d /= 1.0 + edge;
    float q = dot(d, d);
    float h = CAP * r * (1.0 - q) * inv;
    putWater(w, h, -2.0 * CAP * d, 1.3 * px * inv + blur * r * inv, blur, k * CAP * r * inv);
}

// Beads: a raindrop hits the glass, splats, pulls back into a bead, sits,
// slowly shrinks. Whether a cell got a hit is decided by the storm at the
// moment of impact, so the pane gets wetter while it pours and dries out in a
// lull, without anything popping. Searches the 2x2 nearest cells, so beads lie
// anywhere and never line up on a grid.
// spread = false keeps each bead inside its own cell (one lookup, for the fine spray).
void beads(inout Water w, vec2 uv, float t, float dens, float kmax, float px, float seed,
           float life, float rmax, float inv, float dof, bool spread) {
    int n2 = spread ? 2 : 1;
    vec2 base = spread ? floor(uv - 0.5) : floor(uv);
    for (int j = 0; j < n2; j++)
    for (int i = 0; i < n2; i++) {
        vec2 id = base + vec2(i, j);
        vec3 h0 = hash32(id + seed);
        float rate = mix(0.7, 1.4, h0.x) / life;
        float ph = t * rate + h0.y * 17.0;
        float n = floor(ph), f = fract(ph);
        vec3 h = hash32(id * 1.31 + n * 7.17 + seed);
        vec2 c = id + (spread ? h.xy : 0.5 + (h.xy - 0.5) * (1.0 - 2.0 * rmax));
        vec2 dc = uv - c;
        vec3 g = hash32(id * 2.71 + n * 3.13 + seed * 1.7);
        float r0 = rmax * mix(0.3, 1.0, g.x * g.x);                  // many small, few large
        float age = f / rate;                                       // seconds since impact
        float splat = min(uSplash, 1.5) * smoothstep(0.0, 0.015, age) * (1.0 - smoothstep(0.025, 0.16, age));
        bool sats = spread && uSplash > 0.0 && r0 > 4.0 * px;       // big enough to throw satellites
        float reach = sats ? min(2.6 * r0, 0.48) : r0 * (splat > 0.0 ? 2.4 : 1.5);
        if (h.z > dens * kmax || dot(dc, dc) > reach * reach
            || h.z > dens * storm((n - h0.y * 17.0) / rate))
            continue;
        float fade = mix(1.0, 0.7, f) * smoothstep(1.0, 0.93, f);
        float blur = dof * smoothstep(0.75, 1.0, g.z);
        float seedD = g.y * 91.0 + n;

        // the splat: the drop lands, flattens into a ragged sheet, pulls back in
        float grow = smoothstep(0.0, 0.012, age);
        float spread_ = 1.0 + 0.8 * splat;
        float r = min(r0 * fade * grow * spread_, spread ? 0.4 : 0.5 - rmax * 0.5);
        float ang = splat > 0.0 || sats ? atan(dc.y, dc.x) / TAU : 0.0;
        // a crown of uneven spikes while it splats
        float rag = splat > 0.0
                  ? 0.3 * splat * (pow(noiseN(ang * 17.0, 17.0, seedD), 3.0) * 2.2 - 0.35) : 0.0;
        // same volume, so the sheet is thinner: scale its height (inv) down
        addDrop(w, uv, c, r, px, blur, 1.0, seedD, inv / (spread_ * spread_), rag, 0.3);

        // satellites thrown out by the impact; they stay as specks around the bead
        if (sats) {
            float sec = floor(ang * 9.0 + 0.5);
            vec3 hs = hash32(vec2(sec + seedD, n * 1.7 + seed));
            if (hs.z < 0.6 * min(uSplash, 1.0)) {
                float ang = (sec + (hs.x - 0.5) * 0.7) * TAU / 9.0;
                float dist = r0 * mix(1.4, 2.6, hs.y) * smoothstep(0.0, 0.04, age);
                vec2 sc = c + vec2(cos(ang), sin(ang)) * min(dist, reach - 0.02);
                float sr = max(r0 * mix(0.15, 0.32, hs.x * hs.x), 1.5 * px) * fade * smoothstep(0.01, 0.04, age);
                addDrop(w, uv, sc, sr, px, blur, 1.0, hs.x * 33.0, inv, 0.0, 0.0);
            }
        }
    }
}

// Mostly straight with small kinks, the way water finds its way down glass.
float pathX(float y, vec3 h) {
    return 0.22 * (noise1(y * 1.9 + h.x * 40.0) - 0.5) + 0.07 * (noise1(y * 6.3 + h.y * 40.0) - 0.5);
}

// Runners: a drop grows heavy, clings, darts down in jerks, and leaves a thin
// wet film that breaks up into a line of tiny beads and then dries.
void runner(inout Water w, inout float wipe, vec2 uv, float t, float dens, float kmax, float px,
            float layer, float H, float rmax, float inv) {
    float col = floor(uv.x);
    vec3 hc = hash31(col + 3.7 + layer * 17.0);
    float rate = mix(0.025, 0.05, hc.x);
    float ph = t * rate + hc.z * 7.0;
    float n = floor(ph), f = fract(ph);
    vec3 h = hash32(vec2(col, n) * vec2(1.0, 7.1) + 31.0 + layer * 5.0);
    if (h.z > dens * kmax || h.z > dens * storm((n - hc.z * 7.0) / rate))
        return;
    vec2 p = vec2(fract(uv.x) - 0.5 - (hc.y - 0.5) * 0.2, uv.y);

    // stick-slip; 85 % of the cycle on the pane, the rest lets its trail dry
    float run = min(f / 0.85, 1.0);
    float steps = 3.0 + floor(h.x * 5.0);
    float st = run * steps, s = fract(st);
    float slip = (floor(st) + smoothstep(0.55, 1.0, s)) / steps;
    slip = mix(slip, run, 0.2);
    float r = rmax * mix(0.7, 1.0, h.y);
    float yc = mix(H + 2.0 * r, -0.4 - 3.0 * r, slip);
    float moving = smoothstep(0.55, 0.75, s);
    r *= mix(0.94, 1.06, s < 0.55 ? s / 0.55 : 1.0 - (s - 0.55) / 0.45);   // swells, then sheds
    float dry = smoothstep(1.0, 0.86, f);

    addDrop(w, p, vec2(pathX(yc, h), yc), r, px, 0.0, mix(0.85, 0.55, moving), h.x * 53.0 + n, inv,
            0.0, 0.0);

    float above = p.y - yc;
    float tlen = 1.4;
    if (above <= 0.0 || above > tlen)
        return;
    float age = above / tlen;
    float x = p.x - pathX(p.y, h);
    // the drop swept everything in its path; fog and beads come back slowly
    wipe = max(wipe, (1.0 - smoothstep(0.7 * r, 1.0 * r, abs(x))) * (1.0 - age) * dry);

    // film: continuous behind the drop, then it necks and breaks up
    float tw = r * mix(0.3, 0.16, age);
    float neck = smoothstep(0.25, 0.6, noise1(p.y * 9.0 / r * 0.1 + h.z * 30.0) + 0.6 - age * 1.4);
    float hf = r * 0.12 * (1.0 - age) * neck * dry;
    float q = x / tw;
    if (abs(q) < 1.0 && hf > 0.002 * r)
        putWater(w, hf * (1.0 - q * q) * inv, vec2(-2.0 * hf * q / tw, 0.0), 1.3 * px * inv, 0.0, 0.0);

    // residue: beads left at random along the path, shrinking as they dry
    float sp = r * 0.9;
    float by = (floor(p.y / sp) + 0.5) * sp;
    vec3 hb = hash32(vec2(by * 17.0 + n, h.x * 91.0 + layer));
    float bAge = (by - yc) / tlen;
    if (hb.x > 0.4 && bAge > r * 1.6 / tlen) {
        float br = r * mix(0.1, 0.32, hb.y * hb.y) * smoothstep(1.0, 0.5, bAge) * dry;
        addDrop(w, p, vec2(pathX(by, h) + (hb.z - 0.5) * r * 0.5, by), br, px, 0.0, 1.0,
                hb.z * 77.0, inv, 0.0, 0.0);
    }
}

Water glass(vec2 uv, float t, float k, float px, out float wipe) {
    float s = uScale, a = uDrops;
    float kmax = uRain * mix(1.0, 1.75, uVariation);
    float capR = uMaxDrop * px;                  // largest radius, screen units
    Water w = dry();
    wipe = 0.0;

    float z1 = 6.0 / s, z2 = 9.5 / s;
    runner(w, wipe, uv * z1, t, 0.5 * a, kmax, px * z1, 0.0, z1, min(0.0125 * s, capR) * z1, 1.0 / z1);
    runner(w, wipe, uv * z2 + vec2(0.37, 0.0), t * 1.13, 0.42 * a, kmax, px * z2, 1.0, z2,
           min(0.0095 * s, capR) * z2, 1.0 / z2);

    // beads: large and sparse, medium, fine spray
    float dof = min(uDof * uDream, 1.5) * 0.45;
    Water b = dry();
    float z3 = 13.0 / s, z4 = 28.0 / s, z5 = 64.0 / s;
    beads(b, uv * z3, t, 0.3 * a, kmax, px * z3, 0.0, 70.0, min(0.014 * s, capR) * z3, 1.0 / z3, dof, true);
    beads(b, uv * z4 + 7.7, t, 0.42 * a, kmax, px * z4, 1.0, 50.0, min(0.0078 * s, capR) * z4, 1.0 / z4, dof, true);
    beads(b, uv * z5 + 3.1, t, 0.5 * a, kmax, px * z5, 2.0, 35.0, min(0.0036 * s, capR) * z5, 1.0 / z5, 0.0, false);
    b.h -= wipe * max(b.h, 0.0) + wipe * 1e-3;   // the runners swept these away
    if (b.h > w.h)
        w = b;
    // distance to the edge ~ height / slope: an antialiased edge for any shape
    w.m = w.h > 0.0 ? smoothstep(0.0, w.aa, w.h / max(length(w.g), 0.03)) : 0.0;
    return w;
}

// What a drop sees through itself: the world outside the window, far out of
// focus. Bright overcast sky up top, a dark band of ground and buildings
// below it with a few lit windows.
vec3 world(vec2 p, vec3 amb) {
    float hz = 0.5 + 0.1 * (texture(iChannel1, vec2(p.x * 0.05, 0.31)).r - 0.5);
    vec3 sky = mix(vec3(0.6, 0.66, 0.74), vec3(0.88, 0.92, 0.97), smoothstep(hz, hz + 0.9, p.y));
    vec3 ground = vec3(0.07, 0.075, 0.085)
                * (0.7 + 0.6 * texture(iChannel1, p * vec2(0.06, 0.1) + 0.5).g);
    vec3 c = mix(ground, sky, smoothstep(hz - 0.06, hz + 0.1, p.y));
    float lit = smoothstep(0.82, 0.95, texture(iChannel2, p * 0.09).b) * smoothstep(hz, hz - 0.2, p.y);
    c += lit * vec3(0.9, 0.75, 0.5) * 0.6;
    return mix(c, c * (0.6 + 0.8 * amb), 0.5 * min(uDream, 1.0));
}

// Light on the water. A drop is a tiny lens: it shows a small, upside-down
// image of the world behind it, so the dark ground sits in its upper half and
// the bright sky gathers inside its lower rim. The flat middle barely bends
// light and stays clear. Where the surface is steep, rays reflect inside the
// drop and the rim reads dark. The glint is the sky off the curved top.
void shadeWater(inout vec4 acc, Water w, vec2 uv, vec3 amb, float flash) {
    if (w.m < 0.003)
        return;
    float s = length(w.g);
    vec3 n = normalize(vec3(-w.g, 1.0));
    float m = w.m, sharp = 1.0 - min(w.blur * 1.5, 1.0);

    // refraction: the steeper, the further it looks; the image is inverted.
    // Painting light over the desktop washes its colours out, so the bright
    // parts of that image are laid on thinner than the dark ones.
    float bend = smoothstep(0.0, 1.0, s);
    vec3 seen = world(uv + w.g * 0.38, amb) * (1.0 + 1.5 * flash);
    float lum = dot(seen, vec3(0.3, 0.55, 0.15));
    over(acc, seen, (0.03 + 0.42 * bend * bend) * mix(1.0, 0.3, smoothstep(0.15, 0.8, lum)) * m);

    // caustic: light focused just inside the lower edge
    float caus = smoothstep(0.35, 0.8, -n.y / max(s, 1e-3) * bend) * smoothstep(0.55, 0.95, s)
               * (1.0 - smoothstep(0.98, 1.12, s));
    over(acc, mix(vec3(0.92, 0.95, 1.0), amb, 0.4 * min(uDream, 1.0)), 0.3 * caus * m * sharp);

    // rim: total internal reflection, a thin dark line that thickens at the top
    float rim = smoothstep(0.9 - 0.12 * max(n.y / max(s, 1e-3), 0.0), 1.1, s);
    over(acc, vec3(0.012, 0.016, 0.024), 0.5 * rim * m * mix(0.4, 1.0, sharp));

    float band = smoothstep(0.6, 0.85, s) * (1.0 - smoothstep(0.95, 1.1, s));
    vec3 spectrum = 0.5 + 0.5 * cos(TAU * (s * 2.2 + n.y * 0.4 - 0.6 + vec3(0.0, 0.33, 0.67)));
    over(acc, spectrum, band * 0.07 * uPrism * min(uDream, 1.5) * m);

    // glint: a sharp reflection of the brightest patch of sky, plus a soft sheen
    float nh = max(dot(n, normalize(vec3(-0.16, 0.26, 1.0))), 0.0);
    float glint = pow(nh, mix(60.0, 700.0, sharp)) * 0.9
                + pow(nh, 18.0) * 0.06 * (1.0 + uDream);
    over(acc, vec3(1.0), glint * m);
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

// Rain hitting the ground along the bottom of the screen: each impact throws
// up a small crown that spreads and fades, and a few droplets that jump and
// fall back. Three depth layers; far splashes are smaller and sit higher.
// Returns (coverage, brightness).
vec2 groundSplash(vec2 uv, float t, float k, float px) {
    vec2 res = vec2(0.0);
    for (int L = 0; L < 3; L++) {
        float fl = float(L);
        float cw = 0.075 * pow(0.6, fl);                 // cell width, screen heights
        float y0 = 0.004 + 0.022 * fl, yh = 0.018 + 0.012 * fl;  // band of this layer
        float cx = floor(uv.x / cw);
        vec3 hc = hash31(cx * 1.17 + fl * 31.0);
        float rate = mix(1.2, 2.4, hc.x);                // impacts per second, at most
        float ph = t * rate + hc.y * 9.0;
        float n = floor(ph);
        float age = fract(ph) / rate;                    // seconds since impact
        vec3 h = hash32(vec2(cx, n) + fl * 7.3);
        if (age > 0.45 || h.z > 0.32 * k)
            continue;
        vec2 c = vec2((cx + 0.25 + 0.5 * h.x) * cw, y0 + yh * h.y);
        float sz = cw * mix(0.7, 1.0, hc.z);             // splash scale
        vec2 d = uv - c;
        if (abs(d.x) > 0.5 * cw || d.y > 0.6 * sz || d.y < -0.15 * sz)
            continue;
        float a = 0.0, b = 0.0;
        // crown: a flat ring that spreads (seen at a low angle, so squashed)
        float rr = 0.26 * sz * sqrt(min(age / 0.12, 1.0)) + 0.002;
        float e = length(d / vec2(1.0, 0.28)) - rr;
        float lw = max(1.2 * px, 0.03 * sz);
        float ring = (1.0 - smoothstep(0.0, lw, abs(e))) * (1.0 - smoothstep(0.05, 0.25, age));
        ring *= mix(1.0, 0.45, step(0.0, d.y));          // the far side is dimmer
        a += ring * 0.55;
        // the crown's wall: a thin sheet that rises at the start, then drops
        float wallH = 0.22 * sz * sin(min(age / 0.16, 1.0) * 3.14159);
        float wx = abs(d.x) - rr * 0.8 - d.y * 0.7;          // flares outward as it rises
        float wall = (1.0 - smoothstep(0.0, lw, abs(wx))) * step(0.0, d.y) * step(d.y, wallH)
                   * (1.0 - d.y / max(wallH, 1e-4)) * step(age, 0.16);
        a += wall * 0.5;
        // droplets thrown up and out, on ballistic arcs
        for (int j = 0; j < 4; j++) {
            vec3 hj = hash32(vec2(n * 3.1 + float(j), cx + fl * 13.0));
            vec2 v = vec2((hj.x - 0.5) * 2.4 + uWind * 3.0, mix(4.0, 7.0, hj.y)) * sz;
            vec2 pj = v * age - vec2(0.0, 0.5 * 60.0 * sz * age * age);
            if (pj.y < 0.0)
                continue;
            float dr = max(1.1 * px, 0.022 * sz * mix(0.6, 1.2, hj.z));
            a += (1.0 - smoothstep(0.4 * dr, dr, length(d - pj))) * 0.8 * step(hj.z, 0.85);
        }
        float fade = mix(1.0, 0.45, fl / 2.0);           // far ones are hazier
        res = max(res, vec2(min(a, 1.0) * fade, 1.0));
    }
    return res;
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

    if (uGround > 0.0 && q.y < 0.12) {
        vec2 sp = groundSplash(uv, t, k, px);
        over(acc, vec3(0.85, 0.89, 0.95), sp.x * 0.6 * min(uGround, 2.0));
        // spray hanging over the ground in a downpour
        float haze = texture(iChannel1, vec2(uv.x * 0.4 - t * 0.05, uv.y * 2.0)).r;
        over(acc, vec3(0.75, 0.8, 0.88),
             0.05 * uGround * smoothstep(0.6, 1.6, k) * smoothstep(0.07, 0.0, uv.y) * (0.5 + haze));
    }

    float win = floor(t / 7.0);
    vec3 lh = hash31(win + 0.5);
    float lt = fract(t / 7.0) * 7.0 - lh.y * 5.0;
    float flash = step(lh.x, uLightning * 0.6 * min(k, 1.5)) * step(0.0, lt)
                * (exp(-lt * 7.0) + 0.6 * exp(-max(lt - 0.18, 0.0) * 9.0) * step(0.18, lt));
    over(acc, vec3(0.86, 0.9, 1.0), flash * 0.35);

    float wipe;
    Water w = glass(uv, t, k, px, wipe);

    // condensation: faint, low-frequency, hugging the frame of the pane;
    // runners wipe it away and every drop keeps its own spot clear
    float n = texture(iChannel0, uv * 0.03 + vec2(t * 0.001, 0.0)).r * 0.65
            + texture(iChannel0, uv * 0.09).g * 0.35;
    float frame = smoothstep(0.3, 0.75, length((q - 0.5) * vec2(1.0, 1.15)));
    float fog = uFog * smoothstep(0.3, 0.8, n) * mix(0.25, 1.0, frame) * (0.6 + 0.4 * k);
    over(acc, vec3(0.8, 0.84, 0.88), fog * (1.0 - wipe) * (1.0 - w.m));

    shadeWater(acc, w, uv, amb, flash);

    fragColor = vec4(acc.rgb / max(acc.a, 1e-4), acc.a);
}
