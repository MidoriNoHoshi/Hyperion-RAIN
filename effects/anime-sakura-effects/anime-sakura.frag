// anime-sakura.frag — painted sakura cels, held on twos, with inked folds.
// Analytical, continuous trajectories: wind advection, terminal fall under drag,
// independent flutter and full 3D tumble. Stable cell identities avoid popping.
// Piles are a procedural arrangement, not a persistent particle simulation.
#pragma sound wind uPetals
#pragma fps uStep
#pragma param uPetals       1.0
#pragma param uWind         0.18
#pragma param uGusts        0.65
#pragma param uFall         1.0
#pragma param uGravity      1.0
#pragma param uFlutter      1.0
#pragma param uTumble       1.0
#pragma param uSpeed        1.0
#pragma param uSize         1.0
#pragma param uPile         0.4
#pragma param uPileTime     0.0
#pragma param uLight        1.0
#pragma param uLightAngle  -55.0
#pragma param uLightPower   1.0
#pragma param uTranslucency 0.75
#pragma param uVeins        0.65
#pragma param uScreenTint   0.0
#pragma param uTint         0.06
#pragma param uStep 12.0
#pragma param uInk 0.65
uniform float uPetals, uWind, uGusts, uFall, uGravity, uFlutter, uTumble;
uniform float uSpeed, uSize, uPile, uPileTime;
const float uDepth = 0.0;
uniform float uLight, uLightAngle, uLightPower, uTranslucency, uVeins, uScreenTint, uTint;
uniform float uStep, uInk;
const bool CEL = true;
const float TAU = 6.28318530718;

vec3 hash32(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
}
void over(inout vec4 acc, vec4 p) {
    float a = clamp(p.a, 0.0, 1.0);
    acc.rgb = p.rgb * a + acc.rgb * (1.0 - a);
    acc.a = a + acc.a * (1.0 - a);
}
mat2 rotate2(float a) {
    float c = cos(a), s = sin(a);
    return mat2(c, s, -s, c);
}
// Rz * Ry * Rx: projected tangent frame retains the front/back face as it turns.
mat3 orientation(float roll, float pitch, float yaw) {
    float c = cos(yaw), s = sin(yaw), b = cos(pitch), d = sin(pitch);
    mat3 r = mat3(vec3(c, 0.0, -s), vec3(s*d, b, c*d), vec3(s*b, -d, c*b));
    r[0].xy = rotate2(roll) * r[0].xy;
    r[1].xy = rotate2(roll) * r[1].xy;
    r[2].xy = rotate2(roll) * r[2].xy;
    return r;
}

// Noon, warm low sun, blue moonlight. The same light reaches flying and resting petals.
void lighting(out vec3 L, out vec3 key, out vec3 ambient, out vec3 wash) {
    float golden = clamp(uLight, 0.0, 1.0);
    float night = clamp(uLight - 1.0, 0.0, 1.0);
    float a = radians(uLightAngle);
    L = normalize(vec3(sin(a), cos(a), mix(mix(0.9, -0.55, golden), -0.35, night)));
    key = mix(mix(vec3(1.0, 0.96, 0.9), vec3(1.0, 0.77, 0.54), golden),
              vec3(0.48, 0.65, 1.0), night) * max(uLightPower, 0.0);
    ambient = mix(mix(vec3(0.62, 0.55, 0.60), vec3(0.58, 0.43, 0.51), golden),
                  vec3(0.12, 0.15, 0.29), night);
    wash = mix(mix(vec3(0.92, 0.94, 1.0), vec3(1.0, 0.62, 0.29), golden),
               vec3(0.12, 0.19, 0.40), night);
}

// A narrowed attachment point, broad asymmetric shoulders and the characteristic
// split at the tip. Distances are in petal units, including a shallow curled edge.
float silhouette(vec2 q, float seed) {
    float v = q.y;
    float width = 0.71 * sqrt(max(0.0, 1.0 - v*v)) * (0.83 + 0.23*v);
    width *= 1.0 + 0.055 * sin(9.0*v + seed);
    float edge = max(abs(q.x) - width, abs(v) - 1.0);
    float notch = 0.175 - length((q - vec2(0.035, 1.02)) * vec2(1.0, 0.92));
    return max(edge, notch);
}

vec4 petal(vec2 delta, float radius, mat3 frame, vec3 seed, float blur,
           float px, float flex, vec3 L, vec3 key, vec3 ambient) {
    // Cheap rejection before projection, veins and lighting.
    if (length(delta) > radius * 1.55 + px * 2.0)
        return vec4(0.0);
    mat2 projected = mat2(frame[0].xy, frame[1].xy);
    float det = determinant(projected);
    // A real petal has a little thickness; never divide by an edge-on zero.
    if (abs(det) < 0.035) {
        projected[0] += frame[2].xy * (det < 0.0 ? -0.055 : 0.055);
        det = determinant(projected);
    }
    if (abs(det) < 0.008)
        return vec4(0.0);
    vec2 q = inverse(projected) * delta / radius;
    q.x += 0.085 * sin(q.y * 2.6 + seed.x * 5.0) * (1.0 - min(abs(q.y), 1.0));
    // Flexible tissue bends in the airflow rather than behaving like rigid cards.
    q.x += flex*0.055*sin(q.y*2.8);
    q.y += flex*0.045*q.x*q.x;
    float d = silhouette(q, seed.z * TAU);
    float aa = clamp(px / radius / max(sqrt(abs(det)), 0.22), 0.012, 0.7) + blur;
    float alpha = 1.0 - smoothstep(-aa, aa, d);
    if (alpha < 0.002)
        return vec4(0.0);

    // Cupped surface normals: each side catches a different amount of light.
    vec3 n = normalize(frame * vec3(-(0.42 + flex*0.16)*q.x, -0.24*q.y + 0.08 + flex*0.10, 1.0));
    vec3 facing = n.z < 0.0 ? -n : n;
    float diffuse = max(dot(facing, L), 0.0);
    float back = max(dot(-facing, L), 0.0);
    float thickness = 0.45 + 0.35 * (1.0 - q.y) * 0.5;
    float transmit = back * (1.0 - thickness * 0.6) * clamp(uTranslucency, 0.0, 2.0);
    float midrib = exp(-pow((q.x + 0.025*sin(q.y*4.0)) / max(aa, 0.017), 2.0));
    float branch = abs(fract((q.y + 0.92)*3.4 - abs(q.x)*2.8 + 0.08*sin(q.y*7.0)) - 0.5);
    float veins = (midrib * 0.7 + (1.0 - smoothstep(0.025, 0.08 + aa*0.2, branch))
                 * smoothstep(0.035, 0.13, abs(q.x)) * 0.48)
                 * (1.0 - smoothstep(0.66, 0.98, abs(q.y))) * max(uVeins, 0.0);
    float tissue = texture(iChannel0, q*0.065 + seed.xy).r;
    float baseBlush = exp(-3.5*(q.y + 0.85)*(q.y + 0.85));
    vec3 albedo = mix(vec3(1.0, 0.77, 0.85), vec3(0.88, 0.35, 0.54),
                      baseBlush*0.38 + seed.y*0.16);
    // Thin rims are paler; veins remain visible when the sun shines through.
    albedo = mix(albedo, vec3(1.0, 0.89, 0.92), smoothstep(-0.14, 0.0, d)*0.25);
    vec3 col;
    if (CEL) {
        float tone = diffuse + transmit*0.8;
        float bands = tone < 0.28 ? 0.30 : (tone < 0.65 ? 0.63 : 0.93);
        col = albedo * (ambient + key*bands);
        // Hand-inked contour, a single painted fold and quiet paper pigment.
        float outline = smoothstep(-aa - max(0.001, 0.055*max(uInk, 0.0)), -aa, d);
        col = mix(col, vec3(0.40, 0.16, 0.29)*(ambient + key*0.38), outline*clamp(uInk, 0.0, 1.0));
        col *= 0.97 + tissue*0.06;
        col -= vec3(0.12, 0.07, 0.08)*veins*0.40;
    } else {
        vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
        float sheen = pow(max(dot(facing, H), 0.0), 26.0) * 0.17;
        col = albedo*(ambient + key*(diffuse*0.66 + transmit*0.78));
        col += key * (sheen + pow(1.0 - abs(n.z), 3.0)*back*0.16);
        col *= 0.975 + tissue*0.05;
        col *= 1.0 - veins*(0.08 + transmit*0.13);
        alpha *= mix(0.94, 0.78, clamp(transmit, 0.0, 1.0));
    }
    return vec4(clamp(col, 0.0, 1.0), alpha / (1.0 + blur*1.5));
}

float pileHeight(vec2 uv, float t) {
    float grow = uPileTime <= 0.0 ? 1.0 : smoothstep(0.0, uPileTime, t);
    float mound = 0.80 + 0.12*sin(uv.x*8.1 + 0.5) + 0.08*sin(uv.x*19.7 + 2.0);
    return max(uPile, 0.0)*0.075*grow*mound;
}

void flying(inout vec4 acc, vec2 uv, float t, float z, float seed, float px,
            vec3 L, vec3 key, vec3 ambient) {
    float cell = mix(0.12, 0.235, z);
    float wind = uWind*t*0.12 + uGusts*(0.045*sin(t*0.37) + 0.017*sin(t*0.83 + seed));
    float x = uv.x - wind*mix(0.45, 1.0, z) + seed*0.719;
    float cx = floor(x / cell);
    // Neighbor cells are sampled: drifting silhouettes never clip at cell edges.
    for (int ix = -1; ix <= 1; ix++) {
        float column = cx + float(ix);
        vec3 lane = hash32(vec2(column, seed));
        // Drag-limited terminal velocity varies by column and depth. Gravity zero
        // suspends descent; flutter and wind continue unless uSpeed is also zero.
        float velocity = mix(0.032, 0.095, z)*mix(0.75, 1.3, lane.x)
                       * max(uFall, 0.0)*sqrt(max(uGravity, 0.0));
        float y = uv.y + t*velocity + lane.y*4.0;
        float rowHeight = cell*1.35;
        float cy = floor(y / rowHeight);
        for (int iy = -1; iy <= 1; iy++) {
            vec2 id = vec2(column, cy + float(iy));
            vec3 h = hash32(id + seed*13.1), g = hash32(id*1.73 + seed*7.9);
            float density = clamp(uPetals*0.47, 0.0, 0.96);
            if (h.z >= density)
                continue;
            float phase = h.x*TAU;
            float f = t*mix(1.1, 2.25, g.x) + phase;
            vec2 flutter = vec2(sin(f) + 0.32*sin(f*1.83 + phase),
                                0.33*sin(f*1.37 + phase));
            flutter *= min(max(uFlutter, 0.0), 2.0)*cell*0.19;
            flutter.x += sin(t*0.69 + phase)*uGusts*cell*0.07;
            vec2 center = (id + 0.25 + h.xy*0.5)*vec2(cell, rowHeight) + flutter;
            vec2 delta = vec2(x, y) - center;
            float radius = mix(0.006, 0.019, z)*mix(0.72, 1.22, g.y)*clamp(uSize, 0.2, 2.5);
            if (length(delta) > radius*1.55 + px*2.0)
                continue;
            float tumble = max(uTumble, 0.0);
            float roll = phase + tumble*(t*(g.z - 0.5)*0.85 + 0.7*sin(f*0.71));
            float pitch = 0.32 + tumble*(0.88*sin(f*0.81) + 0.25*sin(f*1.71));
            float yaw = phase + tumble*(t*mix(0.45, 1.05, h.y) + 0.40*sin(f));
            float blur = CEL ? 0.0 : max(uDepth, 0.0)*z*z*0.16;
            vec4 p = petal(delta, radius, orientation(roll, pitch, yaw), g, blur, px,
                           sin(f*1.47 + phase)*min(max(uFlutter, 0.0), 2.0), L, key, ambient);
            // Far petals lose contrast in the air; near petals keep their fine tissue.
            p.rgb = mix(p.rgb, vec3(0.73, 0.67, 0.78)*(ambient + key*0.35), (1.0-z)*0.18);
            p.a *= mix(0.65, 1.0, z);
            float top = pileHeight(uv, t);
            p.a *= smoothstep(top*0.65 - radius, top + radius, uv.y);
            over(acc, p);
        }
    }
}

void resting(inout vec4 acc, vec2 uv, float t, float px, vec3 L, vec3 key, vec3 ambient) {
    float height = pileHeight(uv, t);
    if (height <= 0.0 || uv.y > height + 0.035*clamp(uSize, 0.2, 2.5))
        return;
    float spacing = 0.024*clamp(uSize, 0.2, 2.5);
    // Back rows first. Stable overlaps and shaded folds make an actual bed of
    // individual petals rather than a solid pink band along the bottom edge.
    for (int row = 11; row >= 0; row--) {
        float r = float(row);
        float y = height*(r + 0.1)/12.0;
        float radius = spacing*mix(0.83, 0.66, r/11.0);
        if (abs(uv.y - y) > radius*1.6)
            continue;
        float x = uv.x/spacing + r*0.47;
        float col = floor(x);
        for (int j = -1; j <= 1; j++) {
            float id = col + float(j);
            vec3 h = hash32(vec2(id, r + 91.0));
            vec2 delta = vec2((x - id - 0.5 - (h.x-0.5)*0.38)*spacing,
                              uv.y - y - (h.y-0.5)*radius*0.45);
            float rock = sin(t*1.2 + h.x*TAU)*uGusts*0.055*(r/11.0);
            mat3 frame = orientation(h.x*TAU, 0.65 + h.y*0.65 + rock, (h.z-0.5)*0.55);
            vec4 p = petal(delta, radius, frame, h, 0.0, px, rock, L, key, ambient);
            p.rgb *= mix(0.72, 1.0, r/11.0); // occlusion below the exposed top layer
            p.a *= smoothstep(0.0, 0.004, height);
            over(acc, p);
        }
    }
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord/iResolution.y;
    float px = 1.0/iResolution.y;
    float t = (floor(iTime*max(uStep, 1.0))/max(uStep, 1.0)) * max(uSpeed, 0.0);
    vec3 L, key, ambient, wash;
    lighting(L, key, ambient, wash);
    vec4 acc = vec4(0.0);
    // Optional transparent colour wash, independent of petal illumination.
    over(acc, vec4(wash, clamp(uScreenTint, 0.0, 1.0)*clamp(uTint, 0.0, 0.4)));
    flying(acc, uv, t, 0.0, 3.0, px, L, key, ambient);
    flying(acc, uv, t, 0.34, 17.0, px, L, key, ambient);
    flying(acc, uv, t, 0.68, 31.0, px, L, key, ambient);
    flying(acc, uv, t, 1.0, 47.0, px, L, key, ambient);
    resting(acc, uv, t, px, L, key, ambient);
    fragColor = vec4(acc.rgb/max(acc.a, 1e-5), acc.a);
}
