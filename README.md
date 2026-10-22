# Hyperion-RAIN

**Hyperion-RAIN**, a NyaBi project ([nyabi.org](https://nyabi.org)), is a
Hyprland effects overlay programme. The program itself is called `gl-overlay`.
It runs full-screen GLSL shader effects on top of your whole desktop, and every
click and keypress passes straight through to the windows underneath. Effects:

- **rain** (`effects/rain-effects/`): rain on a windowpane. Drops that splatter as they
  hit the glass, then sit as beads and dry out; runners that cling and dart
  down leaving a breaking wet trail; falling rain behind the glass that
  splashes on the ground along the bottom edge; optional dreamy layers.
- **snow** (`effects/snow-effects/`): snowfall through a cold window. Five parallax
  layers of flakes, gusts, frost growing in from the corners, snow settling on
  the bottom edge.
- **anime** (`effects/anime-effects/`): rain drawn the way old anime and Ghibli
  films draw it. Straight pen lines from a short loop of drawings, held on
  twos (12 drawings a second), and splashes that replay the same five cels.

More are planned (fireflies, aurora, film grain, CRT). Each effect can come
with a soundtrack (rain and anime → a rain loop, snow → wind), off by default.

It works on any Wayland compositor with layer-shell support (Hyprland, Sway,
KDE, niri, river, …), but it is developed on Hyprland.

## Build & run

### NixOS / Nix flakes

The flake supports `x86_64-linux` and `aarch64-linux`. It packages the overlay,
GTK4 control panel, desktop launcher, bundled effects and soundtracks, with
libmpv sound support enabled.

Nix only includes tracked files from Git checkouts. If the flake files were just
added locally, run `git add flake.nix flake.lock nix/package.nix` first, or use
`path:.` in place of `.` (for example, `nix run path:.#gl-overlay -- -f 30`).

Run these commands from the repository inside a Wayland session with
layer-shell support (for example, Hyprland or Sway):

```sh
nix run .                                  # open the control panel; use Start for the overlay
nix run .#gl-overlay -- -f 30               # run rain directly
nix run .#gl-overlay -- -s snow -f 30       # run snow instead
nix run .#gl-overlay -- -m on --volume 0.5  # rain with sound
```

The overlay stays in the foreground when started directly. Use another terminal
to control or stop it:

```sh
nix run .#gl-overlay -- ctl toggle
nix run .#gl-overlay -- ctl quit
```

Nix must have flakes enabled. On NixOS, add this to the system configuration
and rebuild if it is not already set:

```nix
nix.settings.experimental-features = [ "nix-command" "flakes" ];
```

The NixOS graphics stack must also be enabled (`hardware.graphics.enable = true;`,
normally configured with the compositor). Run the application as the desktop
user so it can access the Wayland session and audio server.

To build without launching, or install into the user profile:

```sh
nix build .
./result/bin/hyperion-rain
./result/bin/gl-overlay -s anime -f 30
nix profile add .
```

After profile installation, `hyperion-rain` and `gl-overlay` are available on
`PATH`, and the desktop launcher is included. The Hyprland configuration examples
below then work as written. Launchers may need a new login to discover the entry.

For a declarative installation, add the repository as an input to the system
flake (replace the path with the checkout's absolute path):

```nix
inputs.hyperion-rain.url = "path:/path/to/Hyperion-RAIN";
```

Include `hyperion-rain` in the system flake's `outputs` arguments, then add a
module to the target `nixosSystem.modules` list:

```nix
({ pkgs, ... }: {
  environment.systemPackages = [
    hyperion-rain.packages.${pkgs.stdenv.hostPlatform.system}.default
  ];
})
```

For Home Manager, use the same package in `home.packages` instead. Rebuild the
corresponding configuration to install it.

For development, the shell provides the C build dependencies, Python, PyGObject
and GTK4:

```sh
nix develop
meson setup build -Dsound=enabled
ninja -C build
./build/gl-overlay -f 30
python3 gui/hyperion-rain.py
```

Keep `flake.lock` committed for reproducible dependencies; use `nix flake update`
to refresh them.
Installation through Nix does not require `sudo meson install`.

### Meson (other distributions)

```sh
meson setup build && ninja -C build
./build/gl-overlay                         # rain, all outputs
./build/gl-overlay -s snow -f 30           # an effect by name
./build/gl-overlay -s my.frag -o DP-1 -f 30 -p uDrops=1.5 -a 0.8
./build/gl-overlay -m on --volume 0.5      # with the effect's own sound
./build/gl-overlay -m ~/Music/storm.flac   # or your own track, looped
```

Deps (Arch): `wayland wayland-protocols mesa meson`; the control panel also needs `python-gobject gtk4`.
Sound needs `mpv` (libmpv). Without it the daemon builds silent; force either way with
`meson setup build -Dsound=enabled|disabled`.
To install: `sudo meson install -C build`. This installs `gl-overlay`, `hyperion-rain` (the control panel), its launcher entry
`org.nyabi.hyperion_rain.desktop` and the app icon (`share/icons/hicolor/scalable/apps/org.nyabi.hyperion_rain.svg`).
Effects go to `$prefix/share/gl-overlay/effects`.

## Effects layout

Each effect is one directory, `<name>-effects/`, holding its shader `<name>.frag` and its sounds:

```
effects/
  rain-effects/   rain.frag  rain.ogg
  snow-effects/   snow.frag  wind.ogg
  anime-effects/  anime.frag  (uses rain.ogg from rain-effects)
```

`-s` / `ctl load` take an effect name or a path. A name is looked up as `<name>-effects/<name>.frag` in
`./effects`, `~/.local/share/gl-overlay/effects` (your own effects) and `$prefix/share/gl-overlay/effects`,
first match wins. To add an effect, make a new `<name>-effects/` directory in one of those places.

## Control

```sh
gl-overlay ctl toggle               # show/hide
gl-overlay ctl pause | resume       # paused = no frames, ~0% GPU
gl-overlay ctl set uDrops 2         # any `uniform float` in the shader
gl-overlay ctl set opacity 0.5      # global
gl-overlay ctl fps 30               # cap, any value 1..60; 0 = monitor refresh
gl-overlay ctl load snow            # switch effect (or a .frag path)
gl-overlay ctl effects              # list the effects it can find
gl-overlay ctl add uRain -0.2       # nudge (for keybinds)
gl-overlay ctl toggle-pause
gl-overlay ctl sound on | off | toggle   # the effect's soundtrack
gl-overlay ctl sound ~/Music/rain.opus  # your own track, for every effect
gl-overlay ctl sound default            # back to the effect's own
gl-overlay ctl volume 0.4               # 0..1 (also `add volume 0.1` for keybinds)
gl-overlay ctl get | status | reload | quit
```

Sound plays through libmpv, so any format mpv reads works. It pauses when the
overlay is paused or hidden, and its loudness follows the effect's strength
(`uRain` / `uSnow`) including the slow storm drift, so it swells in a downpour
and goes quiet in a lull.

The socket lives at `$XDG_RUNTIME_DIR/gl-overlay.sock` and takes plain text
lines, so `socat` works too. When you save the active shader, the daemon
reloads it automatically. If the new version fails to compile, the error goes
to stderr and the old shader keeps running. Values set with `ctl set` / `-p`
survive reloads of the same file; loading a different effect starts from that
effect's own defaults.

## Control panel

```sh
python3 gui/hyperion-rain.py          # from the repo (installed: hyprland launcher → Hyperion-RAIN, or `hyperion-rain`)
hyperion-rain --run "start; preset storm"
```

The control panel is a small GTK4 window for trying the overlay out, styled like
Hyperion-PAKT. It has four views:

- **effects:** pick the effect (rain, snow; the planned ones are listed, not
  selectable yet). Each effect keeps its own settings.
- **control:** start or stop the daemon, show/hide, pause, frame rate, and a
  stepper plus slider for every parameter. Changes go to the running overlay
  live.
- **presets:** per effect. Rain: dream, realistic, drizzle, quiet teal, storm,
  neon night. Snow: steady, flurries, still night, blizzard.
- **hyprland:** a step-by-step guide to adding it to your dotfiles. It detects
  which config Hyprland uses (Lua `hyprland.lua` or classic `hyprland.conf`),
  checks your chosen keys against your live binds, and generates a snippet
  with your current look built in as `-p` flags. Copy it from there.

On the right is a system log with a prompt. Type `help`, view names, `effect snow`, `start`,
`stop`, `preset <name>`, `theme light`, `copy`, or any daemon command
(`set uRain 1.5`, `add uRain -0.2`, `status`). Settings are remembered in
`~/.config/hyperion-rain/gui.json`. Needs `python-gobject` and `gtk4`.

## Hyprland

The control panel's hyprland view writes these lines for you. By hand, for
Lua config (`hyprland.lua`, `configProvider: lua` in `hyprctl systeminfo`):

```lua
hl.on("hyprland.start", function()        -- or add the line to your existing block
	hl.exec_cmd("gl-overlay -f 30")
end)
hl.bind("SUPER + ALT + R", hl.dsp.exec_cmd("gl-overlay ctl toggle"))
hl.bind("SUPER + ALT + P", hl.dsp.exec_cmd("gl-overlay ctl toggle-pause"))
hl.bind("SUPER + ALT + bracketright", hl.dsp.exec_cmd("gl-overlay ctl add uRain 0.2"), { repeating = true })
hl.bind("SUPER + ALT + bracketleft", hl.dsp.exec_cmd("gl-overlay ctl add uRain -0.2"), { repeating = true })
```

For classic `hyprland.conf`:

```ini
exec-once = gl-overlay -f 30
bind  = SUPER ALT, R, exec, gl-overlay ctl toggle
bind  = SUPER ALT, P, exec, gl-overlay ctl toggle-pause
binde = SUPER ALT, bracketright, exec, gl-overlay ctl add uRain 0.2
binde = SUPER ALT, bracketleft, exec, gl-overlay ctl add uRain -0.2
```

For snow, add `-s snow` to the exec line and nudge `uSnow` instead of `uRain`.
Running from the repo without installing? Use the full path to
`build/gl-overlay` and add `-s /path/to/effects/rain-effects/rain.frag`.

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
- **Sound:** `#pragma sound <name> [param]` names the effect's default
  soundtrack, found as `<name>.{ogg,opus,flac,wav,mp3}` in the effect's own
  directory first, then in any other `<effect>-effects/` directory. With `param`, loudness follows that
  uniform. The bundled `rain.ogg` and `wind.ogg` are synthesised by
  `tools/make-sounds.py`, so they carry no third-party licence.
- **Held drawings:** `#pragma fps <param>` says the picture only changes
  every 1/param s (the shader floors `iTime` itself). The daemon then renders
  once per step, just after it begins, instead of redrawing the same frame.

## rain.frag params

Weather:

| param | default | |
|---|---|---|
| `uRain` | 1.0 | rain strength (0 dry … 2 downpour) |
| `uVariation` | 0.7 | how much strength drifts over time, through lulls and downpours (0 = steady) |
| `uDrops` / `uStreaks` | 1.0 | water on the glass / falling rain, multipliers. The number of drops on the glass follows the rain strength: new drops land at a rate set by the strength when they hit, so the pane gets wetter in a downpour and slowly dries in a lull |
| `uWind` | 0.12 | slant of falling rain |
| `uSpeed` / `uScale` | 1.0 | time scale / drop size |
| `uMaxDrop` | 18 | hard cap on drop radius in screen pixels (same on every monitor) |
| `uFog` | 0.035 | condensation around the edges of the pane |
| `uTint` | 0.04 | overcast veil |
| `uLightning` | 0 | flash chance, more likely in heavy rain |
| `uSplash` | 1.0 | drops splatter into a ragged sheet when they hit the glass, pull back into a bead and leave a few satellite specks |
| `uGround` | 1.0 | rain splashing on the ground along the bottom edge: crowns and droplets, plus spray in a downpour |

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

The water on the glass is a height field (each drop a shallow cap, each trail a
thin film), and the light, the dark rim and the glint all come from its slope.

Cost on Intel UHD (Raptor Lake) at 1920×1200: about 5.8 ms/frame dreamy and
5.0 ms realistic. GPU cost scales with the frame rate: `-f 30` halves it and
the drops still look smooth; `-f 5` or lower is nearly free (a slow slideshow).
Measure your own with `./build/gl-overlay-still -n 120`.

## snow.frag params

| param | default | |
|---|---|---|
| `uSnow` | 1.0 | snowfall strength (0 none … 2 blizzard); the number of flakes follows it |
| `uVariation` | 0.6 | drift between flurries and heavy spells (0 = steady) |
| `uWind` / `uGusts` | 0.12 / 0.5 | steady sideways drift / gusts and swirl |
| `uSize` / `uSpeed` | 1.0 | flake size / time scale |
| `uDepth` | 1.0 | near flakes out of focus |
| `uFrost` | 0.4 | frost growing in from the corners of the pane |
| `uPile` | 0.5 | snow settling on the bottom edge (builds up over the first minutes) |
| `uTint` | 0.03 | cold veil |

About 2.4 ms/frame on the same GPU.

## anime.frag params

| param | default | |
|---|---|---|
| `uRain` | 1.0 | how much rain (0 none … 2 downpour) |
| `uStep` | 12 | drawings per second: 12 = on twos, 8 = on threes, 24 = on ones |
| `uCycle` | 4 | rain drawings in the loop (0 = every drawing new) |
| `uWind` | 0.18 | slant of the lines |
| `uLength` / `uWidth` | 1.0 | line length / pen weight |
| `uFall` | 1.0 | how far the lines drop between drawings |
| `uInk` | 0.6 | line strength |
| `uSplash` / `uSplashSize` | 1.0 | splashes on the ground / their size |
| `uTint` | 0.08 | flat grey-blue wash |

The file says `#pragma fps uStep`: the daemon renders once per drawing, right
after it starts, whatever `-f` says (a lower `-f` still wins). So it costs
about 0.8 ms × 12 a second, close to nothing.

## Previewing without the overlay

`gl-overlay-still` renders a single frame headlessly to a PAM image:

```sh
./build/gl-overlay-still -t 42 -p uDream=0 -o out.pam
./build/gl-overlay-still -s snow -t 300 -o out.pam
magick wallpaper.png out.pam -composite preview.png
```

## How it works

| piece | choice |
|---|---|
| language | C11, ~1.2k lines, no toolkit |
| surface | `zwlr_layer_shell_v1`, layer `OVERLAY`, anchored to all edges, `exclusive_zone = -1` (covers bars), keyboard interactivity `NONE`, one surface per `wl_output` (hotplug handled) |
| passthrough | `wl_surface.set_input_region(<empty region>)`. **Not `NULL`:** `NULL` means *infinite* and would swallow every click |
| GPU | EGL 1.5 (`EGL_PLATFORM_WAYLAND_KHR`) + GLES 3.0, RGBA8 config, one shared context, fullscreen triangle |
| pacing | `wl_surface.frame` callbacks with swap interval 0. No busy loop; when paused or hidden there are zero frames. An optional fps cap (any value, e.g. 1..60) parks early frame callbacks and wakes them with a `timerfd` |
| loop | one `poll()` over the Wayland fd, IPC socket, inotify and timerfd |

Source: `src/wayland.c` (surfaces), `src/render.c` (EGL, shader wrapping),
`src/ipc.c` (socket, CLI, hot reload), `src/sound.c` (soundtrack via libmpv),
`src/main.c` (args, event loop).

## Roadmap

- **Real refraction.** Capture the output via `ext-image-copy-capture-v1`
  (or `wlr-screencopy`), bind it as `iChannel0`, and sample through each drop's
  normal. The overlay itself has to be excluded from the capture.
- `ctl channel N image.png` to load textures.
- An X11 backend (ARGB override-redirect window, XShape empty input) for
  non-Wayland sessions.
- GNOME/Mutter has no layer-shell, so it is unsupported. KDE, Hyprland, Sway,
  niri, river, labwc and Wayfire all work.
