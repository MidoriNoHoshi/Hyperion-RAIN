"""Settings contract and optional GLES rendering checks.

Run: python3 -m unittest discover -s tests -v
Set GL_OVERLAY_STILL to a built gl-overlay-still to also exercise the shaders.
The renderer needs a working surfaceless EGL/GLES3 driver, but no desktop.
"""
import ast
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def effect_metadata():
    # Load only declarative settings, without importing GTK or opening a window.
    tree = ast.parse((ROOT / "gui/hyperion-rain.py").read_text())
    nodes = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            name = getattr(node.targets[0], "id", "")
            if name == "RAIN" or nodes:
                nodes.append(node)
            if name == "EFFECT":
                break
    namespace = {}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "settings", "exec"), namespace)
    return namespace["EFFECTS"]


EFFECTS = effect_metadata()
SAKURA = ("sakura", "anime-sakura")


class SettingsTests(unittest.TestCase):
    def test_effects_and_settings_match_installed_shaders(self):
        for effect in EFFECTS:
            eid = effect["id"]
            with self.subTest(effect=eid):
                source = (ROOT / f"effects/{eid}-effects/{eid}.frag").read_text()
                shader_defaults = {name: float(value) for name, value in re.findall(
                    r"^#pragma param\s+(\w+)\s+([-\d.]+)", source, re.M)}
                specs = [p for _, _, group in effect["groups"] for p in group]
                defaults = {p[0]: p[5] for p in specs}
                self.assertEqual(len(defaults), len(specs), "duplicate setting")
                self.assertEqual(defaults, shader_defaults)
                self.assertLessEqual(len(defaults), 32, "daemon's parameter limit")
                self.assertIn(effect["strength"], defaults)
                for name, _, low, high, _, default, _ in specs:
                    self.assertLessEqual(low, default)
                    self.assertLessEqual(default, high)
                for preset, _, values in effect["presets"]:
                    self.assertLessEqual(values.keys(), defaults.keys(), preset)
                    for name, value in values.items():
                        spec = next(p for p in specs if p[0] == name)
                        self.assertTrue(spec[2] <= value <= spec[3], (preset, name))

    def test_both_sakura_effects_share_motion_pile_and_lighting_controls(self):
        settings = {e["id"]: {p[0]: p[5] for _, _, group in e["groups"] for p in group}
                    for e in EFFECTS if e["id"] in SAKURA}
        realistic = settings["sakura"]
        anime = settings["anime-sakura"]
        self.assertEqual({k: v for k, v in realistic.items() if k != "uDepth"},
                         {k: v for k, v in anime.items() if k not in ("uStep", "uInk")})
        for params in settings.values():
            self.assertEqual(params["uScreenTint"], 0)


@unittest.skipUnless(os.environ.get("GL_OVERLAY_STILL"), "set GL_OVERLAY_STILL for GLES tests")
class RenderingTests(unittest.TestCase):
    def render(self, effect, time=42, **params):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "out.pam"
            command = [os.environ["GL_OVERLAY_STILL"], "-s", effect,
                       "-w", "480", "-h", "300", "-t", str(time), "-o", str(output)]
            for name, value in params.items():
                command += ["-p", f"{name}={value}"]
            subprocess.run(command, cwd=ROOT, check=True, capture_output=True, timeout=30)
            header, pixels = output.read_bytes().split(b"ENDHDR\n", 1)
            self.assertIn(b"DEPTH 4", header)
            self.assertEqual(len(pixels), 480*300*4)
            return pixels

    def test_empty_scene_is_fully_transparent(self):
        for effect in SAKURA:
            with self.subTest(effect=effect):
                frame = self.render(effect, uPetals=0, uPile=0, uScreenTint=0)
                self.assertFalse(any(frame[3::4]))

    def test_lighting_modes_change_petals_and_optional_wash(self):
        for effect in SAKURA:
            with self.subTest(effect=effect):
                frames = [self.render(effect, uLight=light) for light in range(3)]
                self.assertEqual(len(set(frames)), 3)
                self.assertTrue(all(any(frame[3::4]) for frame in frames))
                washes = [self.render(effect, uLight=light, uPetals=0, uPile=0, uScreenTint=1)
                          for light in range(3)]
                self.assertTrue(all(min(frame[3::4]) > 0 for frame in washes))
                self.assertEqual(len(set(washes)), 3)

    def test_pile_amount_and_buildup(self):
        for effect in SAKURA:
            with self.subTest(effect=effect):
                small = self.render(effect, uPetals=0, uPile=.3)
                large = self.render(effect, uPetals=0, uPile=1.5)
                self.assertGreater(sum(large[3::4]), sum(small[3::4]))
                self.assertFalse(any(large[:480*200*4:4]))  # pile stays at the bottom
                start = self.render(effect, time=0, uPetals=0, uPile=1.5, uPileTime=120)
                end = self.render(effect, time=120, uPetals=0, uPile=1.5, uPileTime=120)
                self.assertFalse(any(start[3::4]))
                self.assertGreater(sum(end[3::4]), 0)

    def test_freeze_and_anime_frame_holds(self):
        for effect in SAKURA:
            with self.subTest(effect=effect):
                self.assertEqual(self.render(effect, time=4, uSpeed=0),
                                 self.render(effect, time=12, uSpeed=0))
                self.assertNotEqual(self.render(effect, time=4), self.render(effect, time=5))
        self.assertEqual(self.render("anime-sakura", time=4.01),
                         self.render("anime-sakura", time=4.04))
        self.assertNotEqual(self.render("anime-sakura", time=4.01),
                            self.render("anime-sakura", time=4.10))

    def test_zero_gravity_suspends_descent(self):
        for effect in SAKURA:
            with self.subTest(effect=effect):
                # Freeze all movement except terminal fall; gravity zero must
                # stop this movement without relying on the global time freeze.
                params = dict(uPile=0, uWind=0, uGusts=0, uFlutter=0, uTumble=0)
                self.assertEqual(self.render(effect, time=4, uGravity=0, **params),
                                 self.render(effect, time=6, uGravity=0, **params))
                self.assertNotEqual(self.render(effect, time=4, uGravity=1, **params),
                                    self.render(effect, time=6, uGravity=1, **params))

    def test_all_presets_render(self):
        for effect in EFFECTS:
            if effect["id"] not in SAKURA:
                continue
            for name, _, params in effect["presets"]:
                with self.subTest(effect=effect["id"], preset=name):
                    self.assertTrue(any(self.render(effect["id"], **params)[3::4]))

    def test_control_extremes_render(self):
        for effect in SAKURA:
            with self.subTest(effect=effect):
                tiny = self.render(effect, uSize=.2, uPile=0, uWind=-1, uGusts=2,
                                   uFlutter=2, uTumble=2, uGravity=3, uFall=3)
                large = self.render(effect, uSize=2.5, uPile=2, uVeins=2,
                                    uTranslucency=2, uLightAngle=180, uLightPower=2)
                self.assertTrue(any(tiny[3::4]))
                self.assertTrue(any(large[3::4]))
        no_ink = self.render("anime-sakura", uInk=0)
        self.assertGreater(sum(no_ink[0::4]), 0)


if __name__ == "__main__":
    unittest.main()
