#!/usr/bin/env python3
"""
Hyperion-RAIN control panel, a NyaBi project.

A small GTK4 window to try the overlay out and to write the Hyprland dotfile lines for it. It only talks to the
daemon through its socket (the same lines `gl-overlay ctl` sends) and can start / stop it.

Style = Hyperion-PAKT's terminal / system-log look: NyaBi TTY palette, JetBrains Mono, hairlines, no fills except
the one outlined primary button per place, other keys as "[ text ]", options as "› chosen  other", colour only for
meaning, a log column with a prompt on the right.
"""
import datetime
import getpass
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gdk, GdkPixbuf, Gio, GLib, Gtk, Pango  # noqa: E402

VERSION = "0.2.0"
APP_ID = "org.nyabi.hyperion_rain"                  # = the .desktop file and icon name
HERE = Path(__file__).resolve().parent
REPO = HERE.parent                                   # when run from the source tree
SOCKET = Path(os.environ.get("GL_OVERLAY_SOCKET")
              or Path(os.environ.get("XDG_RUNTIME_DIR", "/tmp")) / "gl-overlay.sock")
PREFS = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "hyperion-rain" / "gui.json"
USER = getpass.getuser()

# --------------------------------------------------------------------------------------------- palette (= PAKT)
DARK = dict(name="dark", bg="#000000", fg="#d4d4d4", dim="#6a6a6a", mid="#a0a0a0", hi="#ffffff",
            line="#161616", box="#212121", raised="#0b0b0b",
            accent="#4c90f0", ok="#87af87", warn="#d7af5f", err="#d75f5f")
LIGHT = dict(name="light", bg="#ffffff", fg="#2a2a2a", dim="#8a8a8a", mid="#5a5a5a", hi="#000000",
             line="#ececec", box="#d6d6d6", raised="#f6f6f6",
             accent="#2d72d2", ok="#4e8a4e", warn="#9a7420", err="#b04040")

CSS = """
* { font-family: "JetBrains Mono", "JetBrainsMono Nerd Font Mono", "JetBrainsMono NFM", monospace;
    font-size: 10.5pt; }
window, .bg { background: {bg}; color: {fg}; }
.label { color: {dim}; font-size: 8.5pt; letter-spacing: 1.2px; }
.small { font-size: 8.5pt; }
.log, .log text { font-size: 9pt; }
.title { color: {hi}; font-weight: bold; font-size: 14pt; }
.big { color: {hi}; font-weight: bold; font-size: 20pt; }
.fg { color: {fg}; } .dim { color: {dim}; } .mid { color: {mid}; } .hi { color: {hi}; }
.ok { color: {ok}; } .warn { color: {warn}; } .err { color: {err}; } .accent { color: {accent}; }
.rule { background: {line}; min-height: 1px; }
.vrule { background: {line}; min-width: 1px; }
.boxed { border: 1px solid {box}; }
.kanji { font-family: "Noto Sans CJK JP", sans-serif; font-weight: 900; font-size: 22pt; }
.prose { font-family: "Noto Sans CJK JP", "Noto Sans", sans-serif; font-size: 10.5pt; color: {fg}; }

button { background: none; border: none; box-shadow: none; outline: none; border-radius: 0;
         min-height: 0; min-width: 0; padding: 3px 0; color: {mid}; }
button:hover { color: {hi}; background: none; }
button.primary { border: 1px solid {mid}; padding: 6px 14px; color: {fg}; }
button.primary:hover { border-color: {hi}; color: {hi}; }
button.danger { color: {err}; }
button.danger:hover { color: {hi}; }
button:disabled, button:disabled label { color: {dim}; }

entry, entry.prompt { background: none; border: none; box-shadow: none; outline: none; border-radius: 0;
                      color: {hi}; caret-color: {accent}; padding: 0; min-height: 0; }
entry.key { border-bottom: 1px solid {box}; padding: 2px 4px; color: {fg}; }
entry.key:focus-within { border-bottom-color: {mid}; }
entry selection, textview text selection { background: {box}; color: {hi}; }

scale { padding: 8px 0; }
scale trough { background: {box}; min-height: 1px; border-radius: 0; border: none; }
scale highlight { background: {mid}; min-height: 1px; min-width: 0; margin: 0; padding: 0;
                  border-radius: 0; border: none; }
scale slider { background: {fg}; min-width: 9px; min-height: 9px; margin: -4px; border-radius: 0;
               border: none; box-shadow: none; outline: none; }
scale:hover slider { background: {hi}; }

textview, textview text { background: transparent; color: {fg}; }
scrolledwindow, viewport { background: transparent; }
scrollbar { background: transparent; border: none; }
scrollbar slider { background: {box}; min-width: 3px; min-height: 3px; border-radius: 0; border: none; }
tooltip, tooltip * { background: {raised}; color: {fg}; border-radius: 0; }
"""

# --------------------------------------------------------------------------------------------- effects
# parameter rows: (name, label, min, max, step, default, hint)
RAIN = [
    ("uRain", "rain", 0, 2, .05, 1.0, "strength · 0 dry … 2 downpour"),
    ("uVariation", "variation", 0, 1, .05, 0.7, "drifts through lulls and downpours"),
    ("uDrops", "glass water", 0, 2, .05, 1.0, "drops on the pane · follows the rain"),
    ("uStreaks", "falling rain", 0, 2, .05, 1.0, "streaks behind the glass"),
    ("uSplash", "splatter", 0, 2, .05, 1.0, "drops burst as they hit the glass"),
    ("uGround", "ground splashes", 0, 2, .05, 1.0, "rain hitting the bottom edge"),
    ("uWind", "wind", -.5, .5, .01, 0.12, "slant of the falling rain"),
    ("uScale", "drop size", .4, 2, .05, 1.0, "all drops, big and small"),
    ("uMaxDrop", "max drop", 4, 40, 1, 18, "largest drop radius, px"),
    ("uSpeed", "speed", 0, 3, .05, 1.0, "time scale"),
    ("uFog", "condensation", 0, .3, .005, 0.035, "fog at the pane's edges"),
    ("uTint", "overcast", 0, .3, .005, 0.04, "grey veil"),
    ("uLightning", "lightning", 0, 1, .05, 0.0, "flash chance"),
]
DREAM = [
    ("uDream", "dream", 0, 2, .05, 1.0, "master · 0 realistic"),
    ("uBokeh", "bokeh", 0, 2, .05, 1.0, "blurred lights behind the glass"),
    ("uShafts", "light shafts", 0, 2, .05, 1.0, "rays; rain glitters in them"),
    ("uPrism", "prism", 0, 3, .05, 1.0, "spectral drop edges"),
    ("uMist", "mist", 0, 2, .05, 1.0, "haze low on the screen"),
    ("uDof", "depth of field", 0, 2, .05, 1.0, "some beads out of focus"),
    ("uGrade", "grade", 0, 2, .05, 1.0, "dusk blue → violet"),
    ("uHue", "hue", 0, 1, .01, 0.0, "rotate the palette"),
]
SNOW = [
    ("uSnow", "snowfall", 0, 2, .05, 1.0, "strength · 0 none … 2 blizzard"),
    ("uVariation", "variation", 0, 1, .05, 0.6, "drifts between flurries and heavy spells"),
    ("uWind", "wind", -.5, .5, .01, 0.12, "steady sideways drift"),
    ("uGusts", "gusts", 0, 2, .05, 0.5, "turbulence and swirl"),
    ("uSize", "flake size", .3, 2.5, .05, 1.0, "all flakes, far and near"),
    ("uDepth", "depth of field", 0, 2, .05, 1.0, "near flakes out of focus"),
    ("uSpeed", "speed", 0, 3, .05, 1.0, "time scale"),
    ("uFrost", "frost", 0, 1.5, .05, 0.4, "crystals from the pane's corners"),
    ("uPile", "settling", 0, 2, .05, 0.5, "snow builds up on the bottom edge"),
    ("uTint", "cold veil", 0, .3, .005, 0.03, "pale blue veil"),
]
OPACITY = ("opacity", "opacity", 0, 1, .05, 1.0, "the whole overlay, any effect")
VOLUME = ("volume", "volume", 0, 1, .05, 0.6, "follows the weather's strength")

# Each effect is effects/<id>-effects/<id>.frag (+ its sounds). `strength` is what the more / less keys nudge.
EFFECTS = [
    dict(id="rain", kanji="雨", strength="uRain", sound="rain",
         desc="rain on a windowpane: beads, runners and their trails, falling streaks, optional dream layers",
         groups=[("weather", "", RAIN), ("dream", "every layer below × dream", DREAM)],
         presets=[
             ("dream", "the default: dusk grade, bokeh, light shafts", {}),
             ("realistic", "just a rainy window, no dream layers", {"uDream": 0}),
             ("drizzle", "light, steady, a little condensation",
              {"uRain": .45, "uVariation": .4, "uStreaks": .6, "uFog": .02, "uDream": 0}),
             ("quiet teal", "soft rain in a cool teal dream", {"uDream": 1.5, "uHue": .55, "uRain": .6}),
             ("storm", "heavy, windy, lightning",
              {"uRain": 1.8, "uVariation": .3, "uLightning": .6, "uDream": .4, "uWind": .25}),
             ("neon night", "strong colour, lots of bokeh", {"uDream": 2, "uHue": .8, "uBokeh": 1.6, "uShafts": .4}),
         ]),
    dict(id="snow", kanji="雪", strength="uSnow", sound="wind",
         desc="snowfall seen through a cold window: parallax flakes, frost in the corners, settling snow",
         groups=[("snowfall", "", SNOW)],
         presets=[
             ("steady", "the default", {}),
             ("flurries", "light, slow, a few flakes", {"uSnow": .4, "uGusts": .3, "uPile": .2}),
             ("still night", "big soft flakes, no wind",
              {"uSnow": .7, "uWind": 0, "uGusts": .1, "uSize": 1.5, "uSpeed": .7}),
             ("blizzard", "heavy, windy, frosted over",
              {"uSnow": 2, "uWind": .4, "uGusts": 1.5, "uFrost": .9, "uVariation": .3, "uPile": 1}),
         ]),
]
EFFECT = {e["id"]: e for e in EFFECTS}
PLANNED = [  # shown in the effects list, not selectable yet
    ("fireflies", "蛍", "slow drifting lights low on the screen"),
    ("aurora", "光", "curtains of light along the top edge"),
    ("film grain", "粒", "grain, gate weave and flicker"),
    ("crt", "線", "scanlines, shadow mask, a little bloom"),
]


def params_of(eid):
    return {p[0]: p for _t, _h, group in EFFECT[eid]["groups"] for p in group}


def defaults_of(eid):
    return {k: p[5] for k, p in params_of(eid).items()}


VIEWS = ["effects", "control", "presets", "hyprland"]
FPS = ("fps", "frames / s", 1, 60, 1, 30, "1 = a slideshow, almost free · 60 = smooth, full GPU cost")
KEYS = [  # (id, label, default combo, ctl command, repeat); {noun} / {strength} = the current effect's
    ("toggle", "show / hide", "SUPER + ALT + R", "toggle", False),
    ("pause", "pause / resume", "SUPER + ALT + P", "toggle-pause", False),
    ("more", "more {noun}", "SUPER + ALT + bracketright", "add {strength} 0.2", True),
    ("less", "less {noun}", "SUPER + ALT + bracketleft", "add {strength} -0.2", True),
]
MODBITS = {"SHIFT": 1, "CAPS": 2, "CTRL": 4, "CONTROL": 4, "ALT": 8, "MOD2": 16, "MOD3": 32,
           "SUPER": 64, "WIN": 64, "LOGO": 64, "MOD4": 64, "MOD5": 128}


def fmt(v, step):
    digits = 0 if step >= 1 else (2 if step >= .01 else 3)
    return f"{v:.{digits}f}"


def ctl(line, timeout=0.4):
    """One request/reply on the daemon socket; None when it isn't running."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect(str(SOCKET))
            s.sendall((line + "\n").encode())
            s.shutdown(socket.SHUT_WR)
            out = b""
            while chunk := s.recv(4096):
                out += chunk
            return out.decode(errors="replace")
    except OSError:
        return None


def kv(text):
    out = {}
    for ln in (text or "").splitlines():
        k, _, v = ln.partition(" ")
        out[k] = v.strip()
    return out


def find_binary():
    """(command for the snippet, path to run now, installed?)

    Installed = next to this script (same prefix) or on PATH. The snippet uses the bare name only for
    /usr/bin and /usr/local/bin: Hyprland's own PATH often lacks ~/.local/bin."""
    dev = REPO / "build" / "gl-overlay"
    inst = HERE / "gl-overlay" if (HERE / "gl-overlay").exists() else shutil.which("gl-overlay")
    if inst:
        inst = str(inst)
        bare = os.path.dirname(inst) in ("/usr/bin", "/usr/local/bin")
        return ("gl-overlay" if bare else inst), inst, True
    if dev.exists():
        return str(dev), str(dev), False
    return "gl-overlay", None, False


def find_shader(installed, effect):
    """The -s argument: the bare effect name for an installed daemon (it searches its own shader
    directories), the absolute path when running from build/ (Hyprland's cwd isn't this repo)."""
    dev = REPO / "effects" / f"{effect}-effects" / f"{effect}.frag"
    if not installed and dev.exists():
        return str(dev)
    return None if effect == "rain" else effect


# ------------------------------------------------------------------------------------------------ small widgets
def lbl(text, *classes, xalign=0.0, wrap=False, markup=False, width=None, sel=False):
    w = Gtk.Label(xalign=xalign)
    if markup:
        w.set_markup(text)
    else:
        w.set_text(text)
    for c in classes:
        w.add_css_class(c)
    if wrap:
        w.set_wrap(True)
        w.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
    if width:
        w.set_size_request(width, -1)
    w.set_selectable(sel)
    return w


def label(text):
    """NyaBi .log-head: dim, uppercase, letter-spaced."""
    return lbl(text.upper(), "label")


def rule(vertical=False):
    b = Gtk.Box()
    b.add_css_class("vrule" if vertical else "rule")
    return b


def btn(text, on_click, kind="plain"):
    """One outlined primary per place; the rest are bracketed text keys."""
    b = Gtk.Button(label=text if kind == "primary" else f"[ {text} ]")
    b.add_css_class(kind)
    b.set_halign(Gtk.Align.START)
    b.connect("clicked", lambda *_: on_click())
    return b


def section(title, hint=""):
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
    head = Gtk.Box(spacing=10)
    head.append(label(title))
    if hint:
        head.append(lbl(hint, "small", "dim"))
    box.append(head)
    return box


def vbox(spacing=0):
    return Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=spacing)


def esc(s):
    return GLib.markup_escape_text(s)


class Choice(Gtk.Box):
    """Options as text: the chosen one bright with an accent marker, the rest dim.  › dark   light"""

    def __init__(self, app, options, selected, on_select):
        super().__init__(spacing=18)
        self.app, self.options, self.selected, self.on_select = app, options, selected, on_select
        self.buttons = []
        for i, o in enumerate(options):
            b = Gtk.Button()
            b.set_child(Gtk.Label())
            b.connect("clicked", lambda _b, i=i: self.pick(i))
            self.append(b)
            self.buttons.append(b)
        app.refreshers.append(self.refresh)
        self.refresh()

    def pick(self, i, notify=True):
        self.selected = i
        self.refresh()
        if notify:
            self.on_select(i)

    def refresh(self):
        p = self.app.p
        for i, (b, o) in enumerate(zip(self.buttons, self.options)):
            on = i == self.selected
            mark = f'<span foreground="{p["accent"]}">{"›" if on else " "}</span> '
            b.get_child().set_markup(mark + f'<span foreground="{p["hi" if on else "dim"]}">{esc(o)}</span>')


class Stepper:
    """PAKT stepper ( name  [ − ]  value  [ + ] ) with a hairline slider and a dim hint."""

    def __init__(self, app, spec, store, on_change=None):
        self.app, self.store, self.on_change = app, store, on_change
        self.name, text, lo, hi, step, default, hint = spec
        self.step = step
        row = Gtk.Box(spacing=10)
        n = lbl(text, "mid", width=130)
        n.set_tooltip_text(f"{self.name} · default {fmt(default, step)}")
        row.append(n)
        row.append(btn("−", lambda: self.nudge(-1)))
        self.value = lbl("", "hi", xalign=1.0, width=56)
        row.append(self.value)
        row.append(btn("+", lambda: self.nudge(1)))
        self.scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, lo, hi, step)
        self.scale.set_draw_value(False)
        self.scale.set_hexpand(True)
        self.scale.set_size_request(120, -1)
        self.scale.connect("value-changed", self.changed)
        row.append(self.scale)
        h = lbl(hint, "small", "dim", width=200)
        h.set_ellipsize(Pango.EllipsizeMode.END)
        row.append(h)
        self.widget = row
        self.set(store[self.name])

    def set(self, v):
        self.app.quiet += 1
        self.scale.set_value(v)
        self.app.quiet -= 1
        self.value.set_text(fmt(self.scale.get_value(), self.step))

    def nudge(self, d):
        self.scale.set_value(self.scale.get_value() + d * self.step)

    def changed(self, scale):
        v = round(scale.get_value() / self.step) * self.step
        self.value.set_text(fmt(v, self.step))
        if not self.app.quiet:
            (self.on_change or self.app.set_param)(self.name, v, self.store)


# --------------------------------------------------------------------------------------------------------- app
class RainPanel(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID)
        prefs = self.load_prefs()
        self.theme = prefs.get("theme", "dark")
        self.p = DARK if self.theme == "dark" else LIGHT
        self.effect = prefs.get("effect", "rain") if prefs.get("effect") in EFFECT else "rain"
        saved = prefs.get("values", {})
        if "uRain" in saved:                                 # prefs from 0.1: one flat dict for rain
            saved = {"rain": saved, "_": {"opacity": saved.get("opacity", 1.0)}}
        self.values = {eid: dict(defaults_of(eid), **{k: v for k, v in saved.get(eid, {}).items()
                                                      if k in defaults_of(eid)})
                       for eid in EFFECT}
        self.globals = {"opacity": float(saved.get("_", {}).get("opacity", 1.0)),
                        "volume": float(saved.get("_", {}).get("volume", VOLUME[5]))}
        self.sound = bool(prefs.get("sound", False))
        self.track = prefs.get("track", "")                  # "" = the effect's own sound
        self.fps = min(max(int(prefs.get("fps", 30)), 1), 60) if prefs.get("fps", 30) else 60  # 0 = old "max"
        self.keys = dict({k[0]: k[2] for k in KEYS}, **prefs.get("keys", {}))
        self.view = prefs.get("view", "control")
        self.quiet = 0
        self.refreshers = []
        self.steppers = {}
        self.online = None
        self.status = {}
        self.proc = None
        self.css = Gtk.CssProvider()

    # ---- prefs
    def load_prefs(self):
        try:
            return json.loads(PREFS.read_text())
        except (OSError, ValueError):
            return {}

    def save_prefs(self):
        try:
            PREFS.parent.mkdir(parents=True, exist_ok=True)
            PREFS.write_text(json.dumps(dict(theme=self.theme, effect=self.effect,
                                             values=dict(self.values, _=self.globals), fps=self.fps,
                                             keys=self.keys, view=self.view, sound=self.sound,
                                             track=self.track), indent=1))
        except OSError:
            pass

    # ---- theme
    def apply_theme(self):
        css = CSS
        for k, v in self.p.items():
            css = css.replace("{" + k + "}", v)
        self.css.load_from_string(css)
        for f in self.refreshers:
            f()

    def set_theme(self, name):
        self.theme = name
        self.p = DARK if name == "dark" else LIGHT
        self.apply_theme()
        self.save_prefs()
        self.log("rain", f"theme {name}")

    # ---- window
    def do_activate(self):
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), self.css,
                                                  Gtk.STYLE_PROVIDER_PRIORITY_USER)
        Gtk.Window.set_default_icon_name(APP_ID)
        win = Gtk.ApplicationWindow(application=self, title="Hyperion-RAIN")
        win.set_default_size(1240, 780)
        win.add_css_class("bg")
        root = Gtk.Box()
        win.set_child(root)
        self.win, self.root = win, root

        left = vbox()
        left.set_hexpand(True)
        left.append(self.build_header())
        self.stack = Gtk.Stack()
        self.stack.set_vexpand(True)
        for name, build in (("effects", self.build_effects), ("control", self.build_control),
                            ("presets", self.build_presets), ("hyprland", self.build_hyprland)):
            sw = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER)
            inner = build()
            inner.set_margin_start(28)
            inner.set_margin_end(28)
            inner.set_margin_top(22)
            inner.set_margin_bottom(28)
            sw.set_child(inner)
            self.stack.add_named(sw, name)
        left.append(self.stack)
        root.append(left)
        self.vline, self.hline = rule(vertical=True), rule()
        root.append(self.vline)
        root.append(self.hline)
        self.logcol = self.build_log()
        root.append(self.logcol)
        self.wide = None
        GLib.timeout_add(250, self.relayout)

        self.apply_theme()
        self.switch(self.view, quiet=True)
        self.boot()
        GLib.timeout_add(1000, self.poll)
        win.present()
        if getattr(self, "script", None):
            GLib.timeout_add(400, self.run_script)

    def run_script(self):
        """--run: feed commands through the prompt, one every 600 ms."""
        if not self.script:
            return False
        self.entry.set_text(self.script.pop(0))
        self.on_enter(self.entry)
        return True

    def relayout(self):
        """PAKT layout: wide (>= 1100 px) = view left + 420 px log right; narrow = view top, log bottom 45 %."""
        w, h = self.win.get_width(), self.win.get_height()
        wide = w >= 1100
        if w and wide != self.wide:
            self.wide = wide
            self.root.set_orientation(Gtk.Orientation.HORIZONTAL if wide else Gtk.Orientation.VERTICAL)
            self.vline.set_visible(wide)
            self.hline.set_visible(not wide)
        if w:
            self.logcol.set_size_request(420 if wide else -1, -1 if wide else int(h * 0.45))
            self.logcol.set_vexpand(wide)
        return True

    def build_header(self):
        box = vbox()
        top = Gtk.Box(spacing=12)
        top.set_margin_start(28)
        top.set_margin_end(28)
        top.set_margin_top(20)
        names = vbox(2)
        names.append(lbl("HYPERION // RAIN", "title"))
        names.append(lbl(f"hyprland effects overlay · v{VERSION}", "small", "dim"))
        top.append(names)
        spacer = Gtk.Box()
        spacer.set_hexpand(True)
        top.append(spacer)
        top.append(self.nyabi_badge())
        box.append(top)
        self.views = Choice(self, VIEWS, VIEWS.index(self.view) if self.view in VIEWS else 0,
                            lambda i: self.switch(VIEWS[i]))
        self.views.set_margin_start(28)
        self.views.set_margin_top(14)
        self.views.set_margin_bottom(8)
        box.append(self.views)
        box.append(rule())
        return box

    def nyabi_badge(self):
        """NyaBi's cat (its favicon silhouette) tinted like dim text + "a NyaBi project · nyabi.org"."""
        row = Gtk.Box(spacing=6)
        row.set_valign(Gtk.Align.START)
        self.cat = Gtk.Image()
        self.cat.set_pixel_size(13)
        row.append(self.cat)
        row.append(lbl("a NyaBi project · nyabi.org", "small", "dim"))
        self.refreshers.append(self.tint_cat)
        return row

    def tint_cat(self):
        for d in (HERE / "assets", HERE.parent / "share" / "gl-overlay" / "gui"):
            if (d / "nyabi-cat.png").exists():
                break
        else:
            return
        pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(str(d / "nyabi-cat.png"), 26, 26, True)
        if not pb.get_has_alpha():
            pb = pb.add_alpha(False, 0, 0, 0)
        c = self.p["dim"]
        r, g, b = int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16)
        px = bytearray(pb.get_pixels())
        for i in range(0, len(px), 4):
            px[i], px[i + 1], px[i + 2] = r, g, b
        tex = Gdk.MemoryTexture.new(pb.get_width(), pb.get_height(), Gdk.MemoryFormat.R8G8B8A8,
                                    GLib.Bytes.new(bytes(px)), pb.get_rowstride())
        self.cat.set_from_paintable(tex)

    # ---- views
    def build_control(self):
        box = vbox(28)

        daemon = section("daemon", f"gl-overlay · {SOCKET}")
        stats = Gtk.Box(spacing=40)
        self.stat = {}
        for key, name in (("state", "status"), ("effect", "effect"), ("outputs", "outputs"), ("fps", "fps cap"),
                          ("time", "time")):
            col = vbox()
            col.append(label(name))
            v = lbl("—", "big")
            col.append(v)
            stats.append(col)
            self.stat[key] = v
        daemon.append(stats)
        keys = Gtk.Box(spacing=18)
        self.start_btn = btn("start overlay", self.start_or_stop, "primary")
        keys.append(self.start_btn)
        self.vis_btn = btn("hide", lambda: self.cmd("toggle"))
        self.pause_btn = btn("pause", lambda: self.cmd("toggle-pause"))
        keys.append(self.vis_btn)
        keys.append(self.pause_btn)
        daemon.append(keys)
        box.append(daemon)

        fps = section("frame rate", "GPU cost scales with it: 15 ≈ a quarter of 60")
        self.fps_stepper = Stepper(self, FPS, {"fps": self.fps}, self.set_fps)
        fps.append(self.fps_stepper.widget)
        box.append(fps)

        box.append(self.build_sound())

        self.param_box = vbox(28)
        box.append(self.param_box)
        self.build_params()

        tail = Gtk.Box(spacing=40)
        t = section("theme")
        t.append(Choice(self, ["dark", "light"], 0 if self.theme == "dark" else 1,
                        lambda i: self.set_theme(["dark", "light"][i])))
        tail.append(t)
        r = section("defaults")
        r.append(btn("reset all", self.reset))
        tail.append(r)
        box.append(tail)
        return box

    def build_sound(self):
        snd = section("sound", "a looping soundtrack · off until you turn it on")
        self.sound_choice = Choice(self, ["off", "on"], int(self.sound), self.set_sound)
        snd.append(self.sound_choice)
        st = Stepper(self, VOLUME, self.globals)
        self.volume_stepper = st
        snd.append(st.widget)
        row = Gtk.Box(spacing=10)
        row.append(lbl("track", "mid", width=130))
        self.track_label = lbl("", "hi")
        self.track_label.set_hexpand(True)
        self.track_label.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        row.append(self.track_label)
        row.append(btn("choose file", self.choose_track))
        row.append(btn("default", lambda: self.set_track("")))
        snd.append(row)
        self.refreshers.append(self.refresh_sound)
        return snd

    def refresh_sound(self):
        if not hasattr(self, "track_label"):
            return
        p = self.p
        if self.track:
            text = f'{esc(Path(self.track).name)}  <span foreground="{p["dim"]}">· your own, every effect</span>'
        elif EFFECT[self.effect].get("sound"):
            text = (f'{esc(EFFECT[self.effect]["sound"])}  '
                    f'<span foreground="{p["dim"]}">· the {esc(self.effect)} default</span>')
        else:
            text = f'<span foreground="{p["dim"]}">none for {esc(self.effect)}</span>'
        self.track_label.set_markup(text)

    def set_sound(self, i):
        self.sound = bool(i)
        if self.online:
            self.cmd("sound on" if self.sound else "sound off")
        else:
            self.log("rain", f"sound {'on' if self.sound else 'off'} · applies on start", "dim")
        self.save_prefs()
        self.refresh_hypr()

    def set_track(self, path):
        self.track = path
        self.refresh_sound()
        if path and not self.sound:                  # picking a track turns sound on (the daemon does too)
            self.sound = True
            self.sound_choice.pick(1, notify=False)
        if self.online:
            self.cmd(f"sound {path}" if path else "sound default")
        else:
            self.log("rain", f"track {Path(path).name if path else 'default'} · applies on start", "dim")
        self.save_prefs()
        self.refresh_hypr()

    def choose_track(self):
        dialog = Gtk.FileDialog(title="soundtrack", modal=True)
        audio = Gtk.FileFilter(name="audio")
        audio.add_mime_type("audio/*")
        filters = Gio.ListStore.new(Gtk.FileFilter)
        filters.append(audio)
        dialog.set_filters(filters)
        if self.track:
            dialog.set_initial_file(Gio.File.new_for_path(self.track))

        def done(d, res):
            try:
                f = d.open_finish(res)
            except GLib.Error:
                return                                   # cancelled
            if f and f.get_path():
                self.set_track(f.get_path())
        dialog.open(self.win, None, done)

    def build_params(self):
        """The current effect's steppers (+ the global opacity); rebuilt when the effect changes."""
        while child := self.param_box.get_first_child():
            self.param_box.remove(child)
        self.steppers = {}
        groups = EFFECT[self.effect]["groups"]
        for i, (title, hint, group) in enumerate(groups):
            s = section(f"{self.effect} · {title}" if i == 0 else title, hint)
            rows = vbox(2)
            for spec in group:
                st = Stepper(self, spec, self.values[self.effect])
                self.steppers[spec[0]] = st
                rows.append(st.widget)
            if i == 0:
                st = Stepper(self, OPACITY, self.globals)
                self.steppers["opacity"] = st
                rows.append(st.widget)
            s.append(rows)
            self.param_box.append(s)

    def build_effects(self):
        box = vbox(18)
        box.append(lbl("One effect runs at a time. Switching keeps the daemon running and loads the other "
                       "shader; each effect remembers its own settings.", "prose", wrap=True))
        self.effect_rows = {}
        for e in EFFECTS:
            row, mark, use = self.effect_row(e["id"], e["kanji"], e["desc"], True)
            use.connect("clicked", lambda _b, eid=e["id"]: self.set_effect(eid))
            self.effect_rows[e["id"]] = (mark, use)
            box.append(row)
            box.append(rule())
        box.append(section("coming later", "not made yet"))
        for name, kanji, desc in PLANNED:
            row, _m, _u = self.effect_row(name, kanji, desc, False)
            box.append(row)
            box.append(rule())
        self.refreshers.append(self.refresh_effects)
        return box

    def effect_row(self, name, kanji, desc, ready):
        row = Gtk.Box(spacing=18)
        k = lbl(kanji, "big" if ready else "dim")
        k.add_css_class("kanji")
        k.set_size_request(44, -1)
        row.append(k)
        col = vbox(2)
        col.set_hexpand(True)
        col.set_valign(Gtk.Align.CENTER)
        mark = Gtk.Label(xalign=0.0)
        mark.set_markup(f'<span foreground="{self.p["dim"]}">{esc(name)}</span>')
        col.append(mark)
        col.append(lbl(desc, "small", "dim", wrap=True))
        row.append(col)
        use = btn("use" if ready else "soon", lambda: None)
        use.set_valign(Gtk.Align.CENTER)
        use.set_sensitive(ready)
        row.append(use)
        return row, mark, use

    def refresh_effects(self):
        if not hasattr(self, "effect_rows"):
            return
        p = self.p
        for eid, (mark, use) in self.effect_rows.items():
            on = eid == self.effect
            m = f'<span foreground="{p["accent"]}">{"›" if on else " "}</span> '
            m += f'<span foreground="{p["hi" if on else "fg"]}">{esc(eid)}</span>'
            if on:
                m += f'  <span foreground="{p["dim"]}">· active</span>'
            mark.set_markup(m)
            use.set_label("[ active ]" if on else "[ use ]")
            use.set_sensitive(not on)

    def set_effect(self, eid, load=True):
        if eid not in EFFECT:
            self.log("rain", f"no effect '{eid}' · " + ", ".join(EFFECT), "warn")
            return
        if eid == self.effect and load:
            return
        self.effect = eid
        if load and self.online:
            cmd, path, installed = find_binary()
            target = str(REPO / "effects" / f"{eid}-effects" / f"{eid}.frag") if not installed else eid
            reply = ctl(f"load {target}")
            if not reply or reply.startswith("error"):
                self.log("gl-overlay", (reply or "offline").strip(), "err")
            else:
                for k, v in self.values[eid].items():  # the panel's values for it, not the shader's defaults
                    if abs(v - defaults_of(eid)[k]) > 1e-6:
                        ctl(f"set {k} {v:g}")
        self.build_params()
        self.build_preset_rows()
        self.refresh_effects()
        self.refresh_sound()
        self.refresh_hypr()
        self.save_prefs()
        self.log("rain", f"effect {eid}" + ("" if self.online or not load else " · applies on start"), "ok")

    def build_presets(self):
        box = vbox(18)
        box.append(lbl("A preset resets every parameter of the current effect to its default, then applies "
                       "its own values. Fine-tune afterwards in control.", "prose", wrap=True))
        self.preset_box = vbox(18)
        box.append(self.preset_box)
        self.build_preset_rows()
        return box

    def build_preset_rows(self):
        while child := self.preset_box.get_first_child():
            self.preset_box.remove(child)
        box = self.preset_box
        box.append(section(f"{self.effect} presets"))
        for name, desc, vals in EFFECT[self.effect]["presets"]:
            row = Gtk.Box(spacing=16)
            col = vbox(2)
            col.set_hexpand(True)
            col.append(lbl(name, "hi"))
            col.append(lbl(desc, "small", "dim"))
            flags = "  ".join(f"{k}={v:g}" for k, v in vals.items()) or "defaults"
            col.append(lbl(flags, "small", "mid"))
            row.append(col)
            row.append(btn("apply", lambda n=name, v=vals: self.preset(n, v)))
            box.append(row)
            box.append(rule())
        return box

    def build_hyprland(self):
        box = vbox(28)
        self.provider, self.conf_path = self.detect_config()
        self.fmt = "lua" if self.provider == "lua" else "conf"

        where = section("01 · where", "your config")
        real = os.path.realpath(self.conf_path)
        txt = f"Hyprland reads {self.conf_path}" + (f"  →  {real}" if real != str(self.conf_path) else "")
        where.append(lbl(txt, "fg", wrap=True, sel=True))
        prov = "lua (hl.* API)" if self.provider == "lua" else "hyprlang (.conf)"
        where.append(lbl(f"config provider: {prov} · detected with hyprctl systeminfo", "small", "dim", wrap=True))
        self.mention = lbl("", "small", wrap=True)
        where.append(self.mention)
        self.fmt_choice = Choice(self, ["lua", "conf"], 0 if self.fmt == "lua" else 1, self.set_fmt)
        where.append(self.fmt_choice)
        box.append(where)

        keys = section("02 · keys", "checked against your live binds (hyprctl binds)")
        self.key_status = {}
        self.key_labels = {}
        for kid, text, _default, cmd, _rep in KEYS:
            row = Gtk.Box(spacing=12)
            tl = lbl(text, "mid", width=130)
            row.append(tl)
            e = Gtk.Entry()
            e.add_css_class("key")
            e.set_text(self.keys[kid])
            e.set_width_chars(27)
            e.connect("changed", lambda e, kid=kid: self.key_changed(kid, e.get_text()))
            row.append(e)
            st = lbl("", "small", width=150)
            st.set_ellipsize(Pango.EllipsizeMode.END)
            row.append(st)
            self.key_status[kid] = st
            c = lbl(f"ctl {cmd}", "small", "dim", xalign=1.0)
            self.key_labels[kid] = (tl, c, text, cmd)
            c.set_ellipsize(Pango.EllipsizeMode.END)
            c.set_hexpand(True)
            row.append(c)
            keys.append(row)
        box.append(keys)

        snip = section("03 · snippet", "your current look is baked in as -p flags")
        self.how = lbl("", "prose", wrap=True)
        snip.append(self.how)
        self.snippet = Gtk.TextView(editable=False, cursor_visible=False, monospace=True)
        self.snippet.set_wrap_mode(Gtk.WrapMode.CHAR)
        frame = Gtk.Box()
        frame.add_css_class("boxed")
        self.snippet.set_margin_start(14)
        self.snippet.set_margin_end(14)
        self.snippet.set_margin_top(12)
        self.snippet.set_margin_bottom(12)
        self.snippet.set_hexpand(True)
        frame.append(self.snippet)
        snip.append(frame)
        snip.append(btn("copy snippet", self.copy_snippet, "primary"))
        box.append(snip)

        inst = section("04 · install", "optional")
        self.install_note = lbl("", "prose", wrap=True)
        inst.append(self.install_note)
        self.install_cmd = lbl("", "fg", wrap=True, sel=True)
        inst.append(self.install_cmd)
        box.append(inst)

        tips = section("05 · notes")
        for t in (
            "Autostart only runs when Hyprland starts. To see it now, use [ start overlay ] in control "
            "or run the exec line yourself. Binds take effect after `hyprctl reload`.",
            "The overlay is a layer surface named gl-overlay on the overlay layer. Your layersIn / layersOut "
            "animations apply to it (it fades in). If you add blur to every layer, leave gl-overlay out.",
            "It never takes input: clicks, scrolls and keys go to the windows underneath. For games, "
            "`gl-overlay ctl hide` (or the show / hide key) costs nothing while hidden or paused.",
        ):
            tips.append(lbl("· " + t, "prose", wrap=True))
        box.append(tips)

        self.binds = self.load_binds()
        self.refresh_hypr()
        return box

    # ---- log column (system log + prompt)
    def build_log(self):
        col = vbox()
        sw = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER)
        sw.set_vexpand(True)
        self.logview = Gtk.TextView(editable=False, cursor_visible=False, monospace=True)
        self.logview.add_css_class("log")
        self.logview.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        self.logview.set_left_margin(16)
        self.logview.set_right_margin(16)
        self.logview.set_top_margin(14)
        self.logview.set_bottom_margin(14)
        sw.set_child(self.logview)
        self.logscroll = sw
        buf = self.logview.get_buffer()
        self.tags = {}
        for t in ("time", "fg", "dim", "mid", "hi", "ok", "warn", "err", "accent"):
            self.tags[t] = buf.create_tag(t)
        self.refreshers.append(self.retint_log)
        col.append(sw)
        col.append(rule())
        prompt = Gtk.Box(spacing=0)
        prompt.set_margin_start(16)
        prompt.set_margin_end(16)
        prompt.set_margin_top(10)
        prompt.set_margin_bottom(12)
        self.prompt_lbl = Gtk.Label()
        self.prompt_lbl.add_css_class("log")
        prompt.append(self.prompt_lbl)
        self.entry = Gtk.Entry()
        self.entry.add_css_class("prompt")
        self.entry.add_css_class("log")
        self.entry.set_hexpand(True)
        self.entry.connect("activate", self.on_enter)
        prompt.append(self.entry)
        col.append(prompt)
        self.refreshers.append(self.refresh_prompt)
        stamp = datetime.datetime.now().strftime("%m-%d %H:%M")
        self.write([(f"-- Logs begin at {stamp}. --\n", "dim")])
        return col

    def retint_log(self):
        for t in ("fg", "dim", "mid", "hi", "ok", "warn", "err", "accent"):
            self.tags[t].set_property("foreground", self.p[t])
        self.tags["time"].set_property("foreground", self.p["dim"])

    def refresh_prompt(self):
        p = self.p
        self.prompt_lbl.set_markup(f'<span foreground="{p["mid"]}">{esc(USER)}@rain:~/{esc(self.view)}</span>'
                                   f'<span foreground="{p["accent"]}">$</span> ')

    def write(self, parts):
        buf = self.logview.get_buffer()
        for text, tone in parts:
            buf.insert_with_tags(buf.get_end_iter(), text, self.tags[tone])
        GLib.idle_add(self.scroll_log)

    def scroll_log(self):
        adj = self.logscroll.get_vadjustment()
        adj.set_value(adj.get_upper())
        return False

    def log(self, unit, msg, tone="fg"):
        """journal line: HH:MM:SS unit: message"""
        now = datetime.datetime.now().strftime("%H:%M:%S")
        utone = "accent" if unit == "rain" else ("hi" if unit == USER else "mid")
        self.write([(now + " ", "time"), (unit + ": ", utone), (msg + "\n", tone)])

    # ---- commands
    def on_enter(self, entry):
        line = entry.get_text().strip()
        entry.set_text("")
        if not line:
            return
        self.log(USER, line, "hi")
        word, _, rest = line.partition(" ")
        if word in ("help", "?"):
            for h in ("switch <control|presets|hyprland>   (or just the name)",
                      "effect <rain|snow> · start · stop · theme dark|light · preset <name> · copy · clear",
                      "sound on|off · sound <file> · sound default · volume 0.5",
                      "anything else goes to the daemon, e.g.  set uRain 1.5 · add uRain -0.2 · get · status"):
                self.log("rain", h, "mid")
        elif word == "switch" or word in VIEWS or word == "~":
            target = rest.strip() or word
            match = [v for v in VIEWS if v.startswith(target)] if target != "~" else ["control"]
            if match:
                self.switch(match[0])
            else:
                self.log("rain", f"no view '{target}'", "warn")
        elif word == "effect":
            hit = [e for e in EFFECT if e.startswith(rest.strip())] if rest.strip() else []
            if hit:
                self.set_effect(hit[0])
            else:
                self.log("rain", "effects: " + ", ".join(EFFECT) + " · later: " +
                         ", ".join(p[0] for p in PLANNED), "mid")
        elif word == "start":
            if not self.online:
                self.start_or_stop()
        elif word == "stop":
            if self.online:
                self.start_or_stop()
        elif word == "theme" and rest in ("dark", "light"):
            self.set_theme(rest)
        elif word == "preset":
            presets = EFFECT[self.effect]["presets"]
            hit = [p for p in presets if p[0].startswith(rest)] if rest else []
            if hit:
                self.preset(hit[0][0], hit[0][2])
            else:
                self.log("rain", f"{self.effect} presets: " + ", ".join(p[0] for p in presets), "mid")
        elif word == "sound" and rest.strip() and rest.strip() not in ("on", "off", "toggle"):
            path = rest.strip()
            self.set_track("" if path == "default" else os.path.abspath(os.path.expanduser(path))
                           if "/" in path or "." in path else path)
        elif word == "copy":
            self.copy_snippet()
        elif word == "clear":
            self.logview.get_buffer().set_text("")
        else:
            if word in ("set", "add") and rest:
                name = rest.split()[0]
                if name in self.steppers or name == "volume":
                    GLib.timeout_add(150, self.sync)
            if word == "volume":
                GLib.timeout_add(150, self.sync)
            self.cmd(line)

    def cmd(self, line, echo=True):
        reply = ctl(line)
        if reply is None:
            self.log("gl-overlay", "offline · type start", "warn")
            return None
        if echo:
            for ln in reply.strip().splitlines() or ["ok"]:
                self.log("gl-overlay", ln, "err" if ln.startswith("error") else "fg")
        self.poll()
        return reply

    def switch(self, view, quiet=False):
        self.view = view
        self.stack.set_visible_child_name(view)
        self.views.pick(VIEWS.index(view), notify=False)
        self.refresh_prompt()
        if view == "hyprland" and hasattr(self, "binds"):
            self.binds = self.load_binds()
            self.refresh_hypr()
        if not quiet:
            self.log("rain", f"switch {view}", "dim")
        self.save_prefs()

    # ---- daemon
    def boot(self):
        cmd, path, installed = find_binary()
        self.log("rain", f"hyperion-rain {VERSION} · a NyaBi project", "fg")
        if path:
            self.log("rain", f"daemon {'installed' if installed else 'from build/'}: {path}", "dim")
        else:
            self.log("rain", "gl-overlay not found · build it: meson setup build && ninja -C build", "err")
        self.log("rain", "type help", "dim")
        self.poll()

    def flags(self):
        out = []
        if self.fps:
            out += ["-f", str(self.fps)]
        if abs(self.globals["opacity"] - 1.0) > 1e-6:
            out += ["-a", f"{self.globals['opacity']:g}"]
        d = defaults_of(self.effect)
        for k, v in self.values[self.effect].items():
            if abs(v - d[k]) > 1e-6:
                out += ["-p", f"{k}={v:g}"]
        if self.sound:
            out += ["-m", self.track or "on"]
            if abs(self.globals["volume"] - VOLUME[5]) > 1e-6:
                out += ["--volume", f"{self.globals['volume']:g}"]
        return out

    def start_or_stop(self):
        if self.online:
            self.cmd("quit")
            return
        _cmd, path, installed = find_binary()
        if not path:
            self.log("rain", "no gl-overlay binary to start", "err")
            return
        argv = [path]
        shader = find_shader(installed, self.effect)
        if shader:
            argv += ["-s", shader]
        argv += self.flags()
        self.log("rain", "start " + " ".join(shlex.quote(a) for a in argv[1:]), "dim")
        try:
            self.proc = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                         start_new_session=True)
        except OSError as e:
            self.log("rain", str(e), "err")
            return
        os.set_blocking(self.proc.stderr.fileno(), False)
        GLib.io_add_watch(self.proc.stderr.fileno(), GLib.PRIORITY_DEFAULT,
                          GLib.IOCondition.IN | GLib.IOCondition.HUP, self.on_stderr)
        GLib.timeout_add(300, self.poll)

    def on_stderr(self, fd, cond):
        try:
            data = os.read(fd, 65536)
        except BlockingIOError:
            return True
        except OSError:
            return False
        if not data:
            return False
        for ln in data.decode(errors="replace").splitlines():
            ln = ln.removeprefix("gl-overlay: ")
            tone = "err" if "error" in ln or "cannot" in ln or "failed" in ln else "fg"
            self.log("gl-overlay", ln, tone)
        return True

    def poll(self):
        if self.proc and self.proc.poll() is not None:
            self.proc = None
        reply = ctl("status", timeout=0.25)
        online = reply is not None
        if online != self.online:
            was = self.online
            self.online = online
            if was is not None or online:
                self.log("gl-overlay", "ONLINE" if online else "OFFLINE", "ok" if online else "dim")
            if online:
                self.sync()
        self.status = kv(reply)
        snd = self.status.get("sound")
        if online and snd and (snd != "off") != self.sound and hasattr(self, "sound_choice"):
            self.sound = snd != "off"
            self.sound_choice.pick(int(self.sound), notify=False)
            self.save_prefs()
        try:  # fps changed elsewhere (ctl fps, a key bind): follow it
            cap = round(float(self.status.get("fps_cap", "")))
        except ValueError:
            cap = None
        if online and cap and 1 <= cap <= 60 and cap != self.fps and hasattr(self, "fps_stepper"):
            self.fps = cap
            self.fps_stepper.store["fps"] = cap
            self.fps_stepper.set(cap)
            self.save_prefs()
        # started elsewhere (e.g. from hyprland.lua with -s snow): follow the daemon's effect
        running = Path(self.status.get("shader", "")).stem
        if online and running in EFFECT and running != self.effect:
            self.set_effect(running, load=False)
            self.sync()
        self.refresh_daemon()
        return True

    def sync(self):
        """Read the daemon's live values into the steppers."""
        got = kv(ctl("get"))
        if "volume" in got and hasattr(self, "volume_stepper"):
            try:
                self.globals["volume"] = float(got["volume"])
                self.volume_stepper.set(float(got["volume"]))
            except ValueError:
                pass
        for k, v in got.items():
            if k in self.steppers:
                try:
                    self.steppers[k].store[k] = float(v)
                    self.steppers[k].set(float(v))
                except ValueError:
                    pass
        return False

    def refresh_daemon(self):
        s, p = self.status, self.p
        if self.online:
            self.stat["state"].set_markup(f'<span foreground="{p["ok"]}">ONLINE</span>')
            self.stat["effect"].set_text(Path(s.get("shader", "")).stem or "?")
            self.stat["outputs"].set_text(s.get("outputs", "?"))
            cap = s.get("fps_cap", "0")
            self.stat["fps"].set_text("max" if cap in ("0", "") else cap)
            try:
                t = float(s.get("time", 0))
                self.stat["time"].set_text(f"{int(t // 60)}:{int(t % 60):02d}")
            except ValueError:
                pass
            self.start_btn.set_label("stop overlay")
            self.vis_btn.set_label("[ show ]" if s.get("visible") == "0" else "[ hide ]")
            self.pause_btn.set_label("[ resume ]" if s.get("paused") == "1" else "[ pause ]")
        else:
            self.stat["state"].set_markup(f'<span foreground="{p["dim"]}">OFFLINE</span>')
            for k in ("outputs", "fps", "time"):
                self.stat[k].set_text("—")
            self.stat["effect"].set_text(self.effect)
            self.start_btn.set_label("start overlay")
        self.vis_btn.set_sensitive(bool(self.online))
        self.pause_btn.set_sensitive(bool(self.online))

    # ---- parameters
    def set_param(self, name, v, store):
        store[name] = v
        if self.online:
            ctl(f"set {name} {v:g}")
        self.save_prefs()
        if hasattr(self, "snippet"):
            self.refresh_hypr()

    def set_fps(self, _name, v, store):
        self.fps = store["fps"] = int(v)
        if self.online:
            ctl(f"fps {self.fps}")
        self.save_prefs()
        self.refresh_hypr()

    def reset(self):
        self.preset("defaults", {})

    def preset(self, name, vals):
        for k, d in defaults_of(self.effect).items():
            v = vals.get(k, d)
            self.values[self.effect][k] = v
            self.steppers[k].set(v)
            if self.online:
                ctl(f"set {k} {v:g}")
        if not vals and name == "defaults":
            self.globals["opacity"] = 1.0
            self.steppers["opacity"].set(1.0)
            if self.online:
                ctl("set opacity 1")
        self.save_prefs()
        self.refresh_hypr()
        self.log("rain", f"preset {name}" + ("" if self.online else " · applies on start"), "ok")

    # ---- hyprland
    def detect_config(self):
        provider = "hyprlang"
        try:
            out = subprocess.run(["hyprctl", "systeminfo"], capture_output=True, text=True, timeout=2).stdout
            m = re.search(r"configProvider:\s*(\w+)", out)
            if m:
                provider = m.group(1)
        except (OSError, subprocess.SubprocessError):
            pass
        cfg = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "hypr"
        path = cfg / ("hyprland.lua" if provider == "lua" else "hyprland.conf")
        return provider, path

    def load_binds(self):
        try:
            out = subprocess.run(["hyprctl", "binds", "-j"], capture_output=True, text=True, timeout=2).stdout
            return json.loads(out)
        except (OSError, subprocess.SubprocessError, ValueError):
            return None

    def set_fmt(self, i):
        self.fmt = ["lua", "conf"][i]
        self.refresh_hypr()

    def key_changed(self, kid, text):
        self.keys[kid] = text
        self.save_prefs()
        self.refresh_hypr()

    @staticmethod
    def parse_combo(combo):
        parts = [x.strip() for x in combo.split("+") if x.strip()]
        if not parts:
            return None, None, []
        mods = [m.upper() for m in parts[:-1]]
        mask = 0
        for m in mods:
            if m not in MODBITS:
                return None, None, mods
            mask |= MODBITS[m]
        return mask, parts[-1], mods

    def conflict(self, combo):
        mask, key, mods = self.parse_combo(combo)
        if key is None:
            return "warn", "unknown modifier" if mods else "empty"
        if self.binds is None:
            return "dim", "couldn't read hyprctl binds"
        for b in self.binds:
            if b.get("modmask") == mask and str(b.get("key", "")).lower() == key.lower():
                arg = (b.get("arg") or "").strip()
                if "gl-overlay" in arg:
                    return "ok", "already bound to gl-overlay"
                return "warn", f"taken · {b.get('dispatcher', '')} {arg}"[:60]
        return "ok", "free"

    def refresh_hypr(self):
        if not hasattr(self, "snippet"):
            return
        p = self.p
        e = EFFECT[self.effect]
        sub = dict(noun=self.effect, strength=e["strength"])
        for kid, (tl, c, text, cmd) in self.key_labels.items():
            tl.set_text(text.format(**sub))
            c.set_text("ctl " + cmd.format(**sub))
        for kid, st in self.key_status.items():
            tone, text = self.conflict(self.keys[kid])
            st.set_tooltip_text(text)
            st.set_markup(f'<span foreground="{p[tone]}">{esc(text)}</span>')

        cmd, _path, installed = find_binary()
        shader = find_shader(installed, self.effect)
        flags = " ".join(shlex.quote(f) for f in self.flags())
        run = cmd + (f" -s {shader}" if shader else "") + (" " + flags if flags else "")
        if self.fmt == "lua":
            lines = ["-- Hyperion-RAIN · a NyaBi project",
                     "-- autostart (or move the exec line into your existing hyprland.start block)",
                     'hl.on("hyprland.start", function()',
                     f'\thl.exec_cmd("{run}")',
                     "end)", "", "-- keys"]
            for kid, _t, _d, c, rep in KEYS:
                combo = " + ".join(x.strip() for x in self.keys[kid].split("+"))
                opt = ", { repeating = true }" if rep else ""
                lines.append(f'hl.bind("{combo}", hl.dsp.exec_cmd("{cmd} ctl {c.format(**sub)}"){opt})')
            self.how.set_text("Paste into hyprland.lua after your other binds. If you already have an "
                              "hl.on(\"hyprland.start\", …) block (you do if you autostart hyprpaper or dunst "
                              "there), put the hl.exec_cmd line inside it instead of adding a second block.")
        else:
            lines = ["# Hyperion-RAIN · a NyaBi project", f"exec-once = {run}", ""]
            for kid, _t, _d, c, rep in KEYS:
                mask, key, mods = self.parse_combo(self.keys[kid])
                lines.append(f"{'binde' if rep else 'bind'} = {' '.join(mods)}, {key}, exec, {cmd} ctl "
                             f"{c.format(**sub)}")
            self.how.set_text("Paste at the end of hyprland.conf (or a file you `source =` from it).")
        self.snippet.get_buffer().set_text("\n".join(lines))

        try:
            mentioned = "gl-overlay" in Path(self.conf_path).read_text(errors="replace")
        except OSError:
            mentioned = False
        self.mention.set_markup(
            f'<span foreground="{p["ok"]}">already mentions gl-overlay</span>' if mentioned else
            f'<span foreground="{p["dim"]}">no gl-overlay lines in it yet</span>')

        if installed:
            self.install_note.set_text("gl-overlay is installed, so the snippet uses the plain command.")
            self.install_cmd.set_text("")
        else:
            self.install_note.set_text("Right now the snippet points into this repo's build/ folder, so moving "
                                       "or rebuilding the repo breaks it. Install once and the snippet uses the "
                                       "plain command (refresh this view afterwards):")
            self.install_cmd.set_text(f"cd {REPO} && meson setup --reconfigure build --prefix=/usr/local && "
                                      "sudo meson install -C build")

    def copy_snippet(self):
        buf = self.snippet.get_buffer()
        text = buf.get_text(buf.get_start_iter(), buf.get_end_iter(), False)
        Gdk.Display.get_default().get_clipboard().set(text)
        self.log("rain", f"snippet copied · {self.fmt} · {len(text.splitlines())} lines", "ok")


if __name__ == "__main__":
    import sys
    script = []
    if len(sys.argv) > 2 and sys.argv[1] == "--run":     # hyperion-rain --run "start; set uRain 1.5"
        script = [c.strip() for c in sys.argv[2].split(";") if c.strip()]
    elif len(sys.argv) > 1:
        print("usage: hyperion-rain [--run \"command; command…\"]   (commands as typed at the prompt)")
        sys.exit(0 if sys.argv[1] in ("-h", "--help") else 1)
    app = RainPanel()
    app.script = script
    app.run(None)
