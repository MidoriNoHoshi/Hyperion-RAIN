// snow.frag — snowfall over your desktop, seen through a cold window.
//
// Back to front:
//   cold veil -> five parallax layers of flakes (far: tiny and sharp,
//   near: big and out of focus) -> frost creeping in from the corners
//   -> snow settling along the bottom edge
//
// gl-overlay convention: mainImage() writes *straight* RGBA, where alpha is
// how much of the effect covers the desktop.
//
// Live-tune anything:  gl-overlay ctl set uSnow 1.6
//
#pragma sound wind uSnow   // default soundtrack (sounds/wind.ogg), loudness follows uSnow

#pragma param uSnow      1.0   // snowfall strength (0 none .. 2 blizzard)
#pragma param uVariation 0.6   // how much the strength drifts over time (0 = steady)
#pragma param uWind      0.12  // steady sideways drift
#pragma param uGusts     0.5   // gusts and swirl
#pragma param uSpeed     1.0   // time scale
#pragma param uSize      1.0   // flake size
#pragma param uDepth     1.0   // near flakes out of focus
#pragma param uFrost     0.4   // frost creeping in from the corners of the pane
#pragma param uPile      0.5   // snow settling on the bottom edge
#pragma param uTint      0.03  // cold veil

uniform float uSnow, uVariation, uWind, uGusts, uSpeed, uSize, uDepth, uFrost, uPile, uTint;

#define TAU 6.28318530718

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
float noise1(float x) {
    float i = floor(x), f = fract(x);
    return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}

void over(inout vec4 acc, vec3 col, float a) {
    a = clamp(a, 0.0, 1.0);
    acc.rgb = col * a + acc.rgb * (1.0 - a);
    acc.a = a + acc.a * (1.0 - a);
}

// Snowfall strength: drifts slowly between flurries and heavy spells.
float storm(float t) {
    float n = noise1(t / 50.0) * 0.6 + noise1(t / 17.0 + 5.0) * 0.3 + noise1(t / 5.0 + 9.0) * 0.1;
    return uSnow * mix(1.0, 0.25 + 1.5 * smoothstep(0.2, 0.8, n), uVariation);
}

// One parallax layer. z: 0 = far (tiny, slow, sharp) .. 1 = near (big, fast,
// out of focus). Each cell holds at most one flake, which swings side to side
// inside it as it tumbles, so a single lookup per layer is enough.
// Returns premultiplied white coverage in .x, a glint in .y.
vec2 flakes(vec2 uv, float t, float cells, float z, float dens, float px, float seed) {
    // wind: steady drift + slow gusts that shove whole layers, nearer = more
    float gust = (noise1(t * 0.08 + seed) - 0.5) * 2.4 + (noise1(t * 0.23 + seed * 3.0) - 0.5) * 0.8;
    vec2 p = uv;
    p.x -= (uWind * t * 0.6 + gust * uGusts * 0.35) * mix(0.35, 1.0, z);
    p.y += t * mix(0.035, 0.16, z);
    p *= cells;
    p.x += floor(p.y) * 0.37;                    // stagger the rows: no columns
    vec2 id = floor(p);
    vec2 f = fract(p) - 0.5;
    vec3 h = hash32(id + seed);
    float on = smoothstep(h.z, h.z + 0.08, dens);
    if (on <= 0.0)
        return vec2(0.0);

    vec3 g = hash32(id * 1.7 + seed * 3.1);
    float rpx = mix(0.9, 1.9, g.x) * mix(1.0, 7.0, z * z) * uSize;     // radius, px
    float r = min(rpx * px * cells, 0.17);
    float w = mix(0.6, 1.8, g.y);
    float swing = sin(t * w + g.z * TAU) * 0.16 + sin(t * w * 2.3 + h.x * TAU) * 0.05 * uGusts;
    vec2 c = (h.xy - 0.5) * vec2(0.3, 0.5) + vec2(swing, 0.0);
    c.x = clamp(c.x, -0.5 + r, 0.5 - r);
    float d = length((f - c) * vec2(1.0, mix(1.0, 1.15, g.z)));  // tumbling, not quite round

    float blur = min(uDepth, 2.0) * smoothstep(0.45, 1.0, z) * mix(0.6, 1.0, g.x);
    float soft = mix(min(1.4 * px * cells / max(r, 1e-4), 1.0), 1.0, min(blur, 1.0));
    float disc = 1.0 - smoothstep(r * (1.0 - soft), r * (1.0 + 0.3 * soft), d);
    float core = 1.0 - smoothstep(0.0, r * 0.6, d);
    // far flakes fade into the air; near blurry ones spread their light thin
    float a = disc * mix(0.55, 0.95, core) * mix(0.55, 1.0, z) / (1.0 + 1.8 * blur) * on;

    float glint = step(0.993, hash11(dot(id, vec2(1.0, 57.0)) + floor(t * 4.0 + g.z * 4.0)))
                * (1.0 - smoothstep(0.0, r * 0.5, d)) * (1.0 - blur) * on;
    return vec2(a, glint);
}

// Frost: feathery crystals growing in from the corners, thinner along the edges.
float frost(vec2 uv, vec2 q, float aspect) {
    vec2 e = min(q, 1.0 - q) * vec2(aspect, 1.0);     // distance to the side edges, screen units
    float reachField = min(min(e.x, e.y) * 3.2, length(e));
    float n = texture(iChannel0, uv * 0.35).r * 0.55 + texture(iChannel0, uv * 1.3).g * 0.3
            + texture(iChannel0, uv * 4.1).b * 0.15;
    float reach = uFrost * 0.3;
    float m = smoothstep(reach, reach * 0.25, reachField + (n - 0.5) * reach * 0.9);
    // ridged noise draws the needles
    float v = 1.0 - abs(texture(iChannel1, uv * vec2(1.7, 1.4)).r * 2.0 - 1.0);
    float v2 = 1.0 - abs(texture(iChannel1, uv * vec2(5.3, 4.7) + 0.3).g * 2.0 - 1.0);
    float needles = pow(v, 12.0) * 0.65 + pow(v2, 16.0) * 0.35;
    return m * (0.12 + 0.88 * needles) * (0.6 + 0.4 * m);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.y;    // aspect-correct, 1 = screen height
    vec2 q = fragCoord / iResolution.xy;
    float aspect = iResolution.x / iResolution.y;
    float px = 1.0 / iResolution.y;
    float t = iTime * uSpeed;
    float k = storm(t);
    vec4 acc = vec4(0.0);

    // cold veil, a little heavier in a whiteout
    float vig = smoothstep(0.3, 0.95, length(q - 0.5) * 1.3);
    over(acc, vec3(0.78, 0.84, 0.92), uTint * (0.5 + 0.5 * min(k, 2.0)) * (1.0 + vig));

    // flakes, far to near; density follows the snowfall
    float dens = clamp(k * 0.42, 0.0, 1.0);
    // against a bright sky, snow reads a little grey; the far flakes most
    vec3 white = vec3(0.96, 0.97, 1.0), haze = vec3(0.8, 0.83, 0.88);
    float glints = 0.0;
    vec2 f;
    f = flakes(uv, t, 95.0, 0.0, dens, px, 1.0);
    over(acc, haze, f.x * 0.75); glints += f.y;
    f = flakes(uv + 1.3, t, 58.0, 0.25, dens, px, 2.0);
    over(acc, mix(haze, white, 0.4), f.x * 0.85); glints += f.y;
    f = flakes(uv + 2.9, t, 34.0, 0.5, dens * 0.9, px, 3.0);
    over(acc, white, f.x); glints += f.y;
    f = flakes(uv + 4.1, t, 19.0, 0.75, dens * 0.75, px, 4.0);
    over(acc, white, f.x); glints += f.y;
    f = flakes(uv + 6.7, t, 10.0, 1.0, dens * 0.55, px, 5.0);
    over(acc, white, f.x);
    over(acc, vec3(1.0), glints * 0.8);

    if (uFrost > 0.0)
        over(acc, vec3(0.88, 0.93, 1.0), frost(uv, q, aspect) * 0.55);

    // settling snow: builds up over the first few minutes, more when it pours
    if (uPile > 0.0) {
        float grow = smoothstep(0.0, 240.0, t) * mix(0.6, 1.0, min(k, 1.0));
        float x = uv.x;
        float top = uPile * 0.045 * grow
                  * (0.7 + 0.2 * noise1(x * 6.0) + 0.1 * noise1(x * 23.0 + 4.0));
        float dy = top - uv.y;
        float pile = smoothstep(-1.5 * px, 1.5 * px, dy);
        // lit lip on top, cool blue shadow lower down, sparkle in the crust
        float lip = 1.0 - smoothstep(0.0, 0.012, dy);
        vec3 col = mix(vec3(0.72, 0.8, 0.92), vec3(0.98, 0.99, 1.0), 0.45 + 0.55 * lip);
        float grain = texture(iChannel2, uv * 3.0).r;
        col += step(0.985, texture(iChannel3, fragCoord / 256.0).r) * 0.3 * lip;
        over(acc, col * (0.94 + 0.06 * grain), pile * 0.92);
    }

    fragColor = vec4(acc.rgb / max(acc.a, 1e-4), acc.a);
}
