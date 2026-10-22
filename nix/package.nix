{ lib
, stdenv
, meson
, ninja
, pkg-config
, wayland-scanner
, wrapGAppsHook4
, gobject-introspection
, wayland
, wayland-protocols
, libglvnd
, mpv-unwrapped
, gtk4
, python3
}:

let
  python = python3.withPackages (ps: [ ps.pygobject3 ]);
in
stdenv.mkDerivation {
  pname = "hyperion-rain";
  version = "0.2.0";

  src = lib.cleanSource ../.;

  nativeBuildInputs = [
    meson
    ninja
    pkg-config
    wayland-scanner
    wrapGAppsHook4
    gobject-introspection
  ];

  buildInputs = [
    wayland
    wayland-protocols
    libglvnd
    mpv-unwrapped
    gtk4
    python
  ];

  mesonFlags = [ "-Dsound=enabled" ];

  # Pin the GUI interpreter and its PyGObject module to the same Python.
  postPatch = ''
    substituteInPlace gui/hyperion-rain.py \
      --replace-fail '#!/usr/bin/env python3' '#!${python}/bin/python3'
  '';

  meta = {
    description = "Wayland shader effects overlay with a GTK4 control panel";
    homepage = "https://nyabi.org";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
    mainProgram = "hyperion-rain";
  };
}
