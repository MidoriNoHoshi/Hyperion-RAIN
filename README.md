# gl-overlay

A fullscreen, click-through GLSL shader overlay for Wayland. It draws on the
`overlay` layer above every window (bars included) and takes no input, so you
keep using your desktop normally underneath. It ships with `rain.frag`: rain
on a windowpane.

## Build & run

```sh
meson setup build && ninja -C build
./build/gl-overlay                         # rain.frag, all outputs
./build/gl-overlay -s my.frag -o DP-1 -f 30 -p uDrops=1.5 -a 0.8
```

Deps (Arch): `wayland wayland-protocols mesa meson`.
To install: `meson install -C build`. Shaders go to `$prefix/share/gl-overlay/shaders`.

## Control

```sh
gl-overlay ctl toggle               # show/hide
gl-overlay ctl pause | resume       # paused = no frames, ~0% GPU
gl-overlay ctl set uDrops 2         # any `uniform float` in the shader
gl-overlay ctl set opacity 0.5      # global
gl-overlay ctl fps 30               # cap; 0 = monitor refresh
gl-overlay ctl load shaders/x.frag  # swap shader
gl-overlay ctl get | status | reload | quit
```

The socket lives at `$XDG_RUNTIME_DIR/gl-overlay.sock` and takes plain text
lines, so `socat` works too. When you save the active shader, the daemon
reloads it automatically. If the new version fails to compile, the error goes
to stderr and the old shader keeps running.

Hyprland binds:

```ini
exec-once = gl-overlay -f 30
bind = SUPER, F12, exec, gl-overlay ctl toggle
```

## Writing shaders

Shaders are ShaderToy-style: write `mainImage(out vec4, in vec2)` and the
daemon adds the `#version`, the uniforms and `main()`. Available:
`iResolution` (vec3, like ShaderToy, so pasted shaders work), `iTime`,
`iTimeDelta`, `iFrame`, `iMouse`, `iDate`, `iChannel0..3` (256² RGBA noise),
`iChannelResolution`.

The overlay rules:

- **Alpha matters.** Output straight RGBA. Alpha is how much the effect covers
  the desktop. The daemon premultiplies and applies `opacity`. A ShaderToy
  shader that writes `alpha = 1` will cover your screen.
- **Tunable params:** declare `uniform float uFoo;` plus
  `#pragma param uFoo 0.5` to set its default. GLSL ignores the pragma; the
  daemon reads it. Values set over IPC survive reloads.
- **No backdrop sampling.** A layer-shell client can't read the pixels
  beneath it, so "refraction" is faked with highlights and shadows. See
  roadmap.
- **No pointer.** The surface has an empty input region, so it never receives
  pointer events. `iMouse` is zero unless you push it:
  `ctl set iMouse.x 100`.

## rain.frag params

Weather:

| param | default | |
|---|---|---|
| `uRain` | 1.0 | rain strength (0 dry … 2 downpour) |
| `uVariation` | 0.7 | how much strength drifts over time, through lulls and downpours (0 = steady) |
| `uDrops` / `uStreaks` | 1.0 | water on the glass / falling rain, multipliers |
| `uWind` | 0.12 | slant of falling rain |
| `uSpeed` / `uScale` | 1.0 | time scale / drop size |
| `uMaxDrop` | 18 | hard cap on drop radius in screen pixels (same on every monitor) |
| `uFog` | 0.035 | condensation around the edges of the pane |
| `uTint` | 0.04 | overcast veil |
| `uLightning` | 0 | flash chance, more likely in heavy rain |

Dream layers, all scaled by `uDream` (0 = realistic, 1 = dreamy, 2 = more):

| param | |
|---|---|
| `uBokeh` | out-of-focus coloured lights behind the glass, sitting low like street lights |
| `uShafts` | light shafts from the top-left; rain glitters inside them |
| `uPrism` | faint spectral fringe on drop edges |
| `uMist` | slow haze drifting low on the screen |
| `uDof` | some beads out of focus |
| `uGrade` | dusk blue-to-violet colour grade |
| `uHue` | rotate the palette, 0…1 (try 0.5 for cool teal) |

Presets:

```sh
gl-overlay -p uDream=0                                # realistic window
gl-overlay -p uDream=1.5 -p uHue=0.55 -p uRain=0.6    # quiet teal dream
gl-overlay -p uRain=1.8 -p uVariation=0.3 -p uLightning=0.6 -p uDream=0.4  # storm
```

Cost on Intel UHD (Raptor Lake) at 1920×1200: about 5.3 ms/frame dreamy and
4.3 ms realistic. `-f 30` halves that, and the drops still look smooth.
Measure your own with `./build/gl-overlay-still -n 120`.

## Previewing without the overlay

`gl-overlay-still` renders a single frame headlessly to a PAM image:

```sh
./build/gl-overlay-still -t 42 -p uDream=0 -o out.pam
magick wallpaper.png out.pam -composite preview.png
```

## How it works

| piece | choice |
|---|---|
| language | C11, ~1.2k lines, no toolkit |
| surface | `zwlr_layer_shell_v1`, layer `OVERLAY`, anchored to all edges, `exclusive_zone = -1` (covers bars), keyboard interactivity `NONE`, one surface per `wl_output` (hotplug handled) |
| passthrough | `wl_surface.set_input_region(<empty region>)`. **Not `NULL`:** `NULL` means *infinite* and would swallow every click |
| GPU | EGL 1.5 (`EGL_PLATFORM_WAYLAND_KHR`) + GLES 3.0, RGBA8 config, one shared context, fullscreen triangle |
| pacing | `wl_surface.frame` callbacks with swap interval 0. No busy loop; when paused or hidden there are zero frames. An optional fps cap uses a `timerfd` |
| loop | one `poll()` over the Wayland fd, IPC socket, inotify and timerfd |

Source: `src/wayland.c` (surfaces), `src/render.c` (EGL, shader wrapping),
`src/ipc.c` (socket, CLI, hot reload), `src/main.c` (args, event loop).

## Roadmap

- **Real refraction.** Capture the output via `ext-image-copy-capture-v1`
  (or `wlr-screencopy`), bind it as `iChannel0`, and sample through each drop's
  normal. The overlay itself has to be excluded from the capture.
- `ctl channel N image.png` to load textures.
- An X11 backend (ARGB override-redirect window, XShape empty input) for
  non-Wayland sessions.
- GNOME/Mutter has no layer-shell, so it is unsupported. KDE, Hyprland, Sway,
  niri, river, labwc and Wayfire all work.
