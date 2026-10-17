// anime.frag — hand-drawn rain, the way old anime and Ghibli films draw it.
//
// Back to front:
//   grey-blue wash -> far rain lines -> near rain lines -> splashes on the
//   ground along the bottom edge
//
// It is animated like cels, not simulated: the picture is held for 1/uStep s
// (12 = "on twos"), the rain lines come from a short loop of uCycle drawings,
// and every splash plays the same five drawings, mirrored at random.
// `#pragma fps uStep` makes the daemon render once per drawing, so a still
// frame costs nothing in between.
//
// gl-overlay convention: mainImage() writes *straight* RGBA, where alpha is
// how much of the effect covers the desktop.
//
// Live-tune anything:  gl-overlay ctl set uStep 8
//
#pragma sound rain uRain   // default soundtrack (sounds/rain.ogg), loudness follows uRain
#pragma fps uStep

#pragma param uRain      1.0   // how much rain (0 none .. 2 downpour)
#pragma param uStep      12.0  // drawings per second (12 = on twos, 8 = on threes, 24 = on ones)
#pragma param uCycle     4.0   // rain drawings in the loop (0 = every one new)
#pragma param uWind      0.18  // slant of the lines
#pragma param uLength    1.0   // line length
#pragma param uWidth     1.0   // line weight
#pragma param uFall      1.0   // how far the lines drop between drawings
#pragma param uInk       0.6   // line strength
#pragma param uSplash    1.0   // splashes on the ground
#pragma param uSplashSize 1.0  // splash size
#pragma param uTint      0.08  // grey-blue wash over everything

uniform float uRain, uStep, uCycle, uWind, uLength, uWidth, uFall, uInk, uSplash, uSplashSize, uTint;

// sin-free hashes: stable across GPUs and at large inputs.
float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}
vec3 hash32(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
}

void over(inout vec4 acc, vec3 col, float a) {
    a = clamp(a, 0.0, 1.0);
    acc.rgb = col * a + acc.rgb * (1.0 - a);
    acc.a = a + acc.a * (1.0 - a);
}

// A pen line with a hard edge (1 px of antialiasing, no blur): d and w in px.
float ink(float d, float w) {
    return clamp(w - d + 0.5, 0.0, 1.0);
}

// Distance from p to segment a-b, and how far along it (0..1) the closest point is.
vec2 seg(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return vec2(length(pa - ba * h), h);
}

// One sheet of rain lines in drawing `dr`. The sheet is sheared by the wind so
// the lines stay straight and parallel; each cell of a column holds at most one
// line, which never leaves its cell, so one lookup per pixel is enough.
float sheet(vec2 uv, float dr, float cols, float len, float wpx, float dens, float px, float seed) {
    vec2 p = vec2(uv.x + uv.y * uWind, uv.y);
    p.y += dr * 0.37 * uFall;                      // the sheet drops between drawings
    float colW = 1.0 / cols;
    float cx = floor(p.x / colW);
    float rowH = len * 1.6;
    p.y += hash11(cx * 7.13 + seed) * rowH;        // stagger the columns
    float cy = floor(p.y / rowH);
    vec2 f = vec2(fract(p.x / colW), fract(p.y / rowH));

    vec3 h = hash32(vec2(cx, cy) + vec2(seed * 13.0, dr * 31.7));
    if (h.z > dens)
        return 0.0;
    vec3 g = hash32(vec2(cy, cx) * 1.31 + dr * 5.9 + seed);
    float l = mix(0.45, 1.0, g.x);                 // line length, fraction of the room in the cell
    float y0 = g.y * (1.0 - l * 0.62);
    float s = (f.y - y0) / (l * 0.62);             // 0..1 along the line, bottom to top
    if (s < 0.0 || s > 1.0)
        return 0.0;
    // horizontal distance in px; the shear makes the true distance a bit shorter
    float d = abs(f.x - mix(0.2, 0.8, h.x)) * colW / px / sqrt(1.0 + uWind * uWind);
    // a brush stroke: full weight in the middle, thinning to a point at both ends
    float w = wpx * mix(0.6, 1.2, g.z) * (0.3 + 0.7 * sin(3.14159 * s));
    return ink(d, w) * mix(0.55, 1.0, g.z);
}

// A filled stroke from a (radius ra) to b (radius rb), in splash units -> px.
float petal(vec2 q, vec2 a, vec2 b, float ra, float rb, float lw) {
    vec2 e = seg(q, a, b);
    return clamp(0.5 - (e.x - mix(ra, rb, e.y)) * lw, 0.0, 1.0);
}
// A ring lying on the ground (flat ellipse), radius rx, line weight w px.
float ring(vec2 q, float rx, float w, float lw) {
    float r = abs(length(q * vec2(1.0, 4.0)) - rx) / (1.0 + 2.0 * rx);
    return ink(r * lw, w);
}

// The splash, five drawings reused by every splash. q: splash space, 1 = splash
// half-width, y up from the point of impact. Returns ink coverage.
float splashCel(vec2 q, float j, float lw) {
    float a = 0.0;
    if (j < 0.5) {
        // 0: the drop lands: a small cup of three short petals
        a = petal(q, vec2(-0.05, 0.0), vec2(-0.22, 0.3), 0.025, 0.05, lw);
        a = max(a, petal(q, vec2(0.05, 0.0), vec2(0.22, 0.3), 0.025, 0.05, lw));
        a = max(a, petal(q, vec2(0.0, 0.0), vec2(0.0, 0.38), 0.02, 0.045, lw));
        a = max(a, ring(q, 0.2, 0.9, lw));
    } else if (j < 1.5) {
        // 1: the crown: a cup of petals rising from the rim, fat at the tips
        a = petal(q, vec2(-0.34, 0.0), vec2(-0.6, 0.5), 0.025, 0.075, lw);
        a = max(a, petal(q, vec2(0.34, 0.0), vec2(0.6, 0.5), 0.025, 0.075, lw));
        a = max(a, petal(q, vec2(-0.16, 0.03), vec2(-0.26, 0.72), 0.02, 0.07, lw));
        a = max(a, petal(q, vec2(0.16, 0.03), vec2(0.26, 0.72), 0.02, 0.07, lw));
        a = max(a, ring(q, 0.36, 1.0, lw));
    } else if (j < 2.5) {
        // 2: the tips break off as drops, short stubs stay on the rim
        a = petal(q, vec2(-0.78, 0.74), vec2(-0.7, 0.62), 0.065, 0.025, lw);
        a = max(a, petal(q, vec2(0.78, 0.74), vec2(0.7, 0.62), 0.065, 0.025, lw));
        a = max(a, petal(q, vec2(-0.34, 1.0), vec2(-0.31, 0.88), 0.06, 0.025, lw));
        a = max(a, petal(q, vec2(0.34, 1.0), vec2(0.31, 0.88), 0.06, 0.025, lw));
        a = max(a, petal(q, vec2(-0.55, 0.02), vec2(-0.66, 0.24), 0.02, 0.045, lw));
        a = max(a, petal(q, vec2(0.55, 0.02), vec2(0.66, 0.24), 0.02, 0.045, lw));
        a = max(a, petal(q, vec2(-0.2, 0.06), vec2(-0.24, 0.3), 0.018, 0.04, lw));
        a = max(a, petal(q, vec2(0.2, 0.06), vec2(0.24, 0.3), 0.018, 0.04, lw));
        a = max(a, ring(q, 0.6, 1.0, lw));
    } else if (j < 3.5) {
        // 3: the drops fall back, the ring spreads
        a = petal(q, vec2(-1.0, 0.4), vec2(-0.98, 0.5), 0.05, 0.022, lw);
        a = max(a, petal(q, vec2(1.0, 0.4), vec2(0.98, 0.5), 0.05, 0.022, lw));
        a = max(a, petal(q, vec2(-0.42, 0.62), vec2(-0.41, 0.72), 0.045, 0.02, lw));
        a = max(a, petal(q, vec2(0.42, 0.62), vec2(0.41, 0.72), 0.045, 0.02, lw));
        a = max(a, ring(q, 0.9, 0.8, lw));
    } else {
        // 4: a last thin ring, broken in two
        a = ring(q, 1.15, 0.6, lw) * smoothstep(0.12, 0.3, abs(q.x)) * 0.7;
    }
    return a;
}

// Splashes along the bottom of the screen in three depth rows (far = higher and
// smaller). Each spot plays the five drawings, waits a while, then moves on.
float splashes(vec2 uv, float fi, float dens, float px) {
    float a = 0.0;
    for (int row = 0; row < 3; row++) {
        float z = float(row) / 2.0;                // 0 far .. 1 near
        float y0 = mix(0.115, 0.018, z);           // ground line of this row
        float size = mix(0.011, 0.03, z) * uSplashSize;
        float cw = size * 3.2;                     // cell width
        float x = uv.x + uv.y * uWind * 0.4;
        float cx = floor(x / cw);
        vec3 h = hash32(vec2(cx, float(row) * 17.0 + 3.0));
        float period = floor(mix(6.0, 14.0, h.x));  // drawings per cycle: 5 splash + rest
        float n = fi + floor(h.y * period);
        float k = floor(n / period);               // which cycle: a new spot each time
        float j = n - k * period;                  // which drawing of the splash
        if (j > 4.5)
            continue;
        vec3 g = hash32(vec2(cx * 1.7 + k * 3.1, float(row) + k * 0.37));
        if (g.z > dens)
            continue;
        float s = size * mix(0.75, 1.2, g.y);
        vec2 c = vec2((cx + mix(0.3, 0.7, g.x)) * cw, y0 + (g.y - 0.5) * size * 0.8);
        vec2 q = (vec2(x, uv.y) - c) / s;
        if (abs(q.x) > 1.45 || q.y < -0.5 || q.y > 1.15)
            continue;
        q.x *= g.x < 0.5 ? -1.0 : 1.0;             // mirrored drawing, still the same cel
        float lw = s / px;                          // splash units -> px
        a = max(a, splashCel(q, j, lw) * mix(0.7, 1.0, z));
    }
    return a;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.y;    // aspect-correct, 1 = screen height
    vec2 q = fragCoord / iResolution.xy;
    float px = 1.0 / iResolution.y;
    float sps = max(uStep, 1.0);
    float fi = floor(iTime * sps);          // held drawing: changes uStep times a second
    float cyc = floor(uCycle + 0.5);
    float dr = cyc >= 1.0 ? mod(fi, cyc) : fi;
    float k = clamp(uRain, 0.0, 2.0);
    vec4 acc = vec4(0.0);

    // a flat grey-blue wash, slightly heavier at the top, like a painted sky
    over(acc, vec3(0.42, 0.48, 0.58), uTint * (0.75 + 0.5 * q.y) * (0.5 + 0.5 * min(k, 1.0)));

    float wpx = 0.7 * uWidth * max(iResolution.y / 1200.0, 0.5);
    float len = 0.11 * uLength;
    vec3 pale = vec3(0.86, 0.9, 0.96);
    // far sheet: short, thin, faint, many
    float far = sheet(uv, dr, 70.0, len * 0.6, wpx * 0.7, 0.35 * k, px, 1.0);
    over(acc, pale * 0.92, far * uInk * 0.55);
    // near sheet: long, a little heavier, fewer
    float near = sheet(uv + vec2(0.37, 0.0), dr + 7.0, 34.0, len, wpx, 0.3 * k, px, 2.0);
    over(acc, pale, near * uInk);

    if (uSplash > 0.0 && uv.y < 0.16) {
        float s = splashes(uv, fi, clamp(0.45 * k * uSplash, 0.0, 1.0), px);
        over(acc, vec3(0.9, 0.93, 0.97), s * min(uInk * 1.4, 1.0));
    }

    fragColor = vec4(acc.rgb / max(acc.a, 1e-4), acc.a);
}
