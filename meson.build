project('gl-overlay', 'c',
  version : '0.2.0',
  license : 'MIT',
  default_options : ['c_std=c11', 'warning_level=2', 'buildtype=release'])

add_project_arguments('-D_GNU_SOURCE', '-Wno-unused-parameter',
  '-DGL_OVERLAY_DATADIR="@0@"'.format(get_option('prefix') / get_option('datadir') / 'gl-overlay'),
  '-DGL_OVERLAY_VERSION="@0@"'.format(meson.project_version()),
  language : 'c')

wayland_client = dependency('wayland-client')
wayland_egl    = dependency('wayland-egl')
egl            = dependency('egl')
glesv2         = dependency('glesv2')
wayland_protos = dependency('wayland-protocols')
m              = meson.get_compiler('c').find_library('m')
# Soundtrack playback (optional): without libmpv the daemon builds silent.
mpv            = dependency('mpv', required : get_option('sound'))
if mpv.found()
  add_project_arguments('-DHAVE_MPV', language : 'c')
endif

scanner = find_program(dependency('wayland-scanner', native : true)
  .get_variable('wayland_scanner'))

protos = [
  wayland_protos.get_variable('pkgdatadir') / 'stable/xdg-shell/xdg-shell.xml',
  'protocol/wlr-layer-shell-unstable-v1.xml',
]

proto_src = []
foreach p : protos
  name = p.split('/')[-1].replace('.xml', '')
  proto_src += custom_target(name + '-code',
    input : p, output : name + '-protocol.c',
    command : [scanner, 'private-code', '@INPUT@', '@OUTPUT@'])
  proto_src += custom_target(name + '-header',
    input : p, output : name + '-client-protocol.h',
    command : [scanner, 'client-header', '@INPUT@', '@OUTPUT@'])
endforeach

executable('gl-overlay',
  'src/main.c', 'src/wayland.c', 'src/render.c', 'src/ipc.c', 'src/sound.c', proto_src,
  dependencies : [wayland_client, wayland_egl, egl, glesv2, m, mpv],
  install : true)

install_subdir('shaders', install_dir : get_option('datadir') / 'gl-overlay')
# Default soundtracks (regenerate with tools/make-sounds.py).
install_subdir('sounds', install_dir : get_option('datadir') / 'gl-overlay')

# Headless single-frame renderer for previews / shader development.
executable('gl-overlay-still',
  'src/still.c', 'src/render.c', 'src/wayland.c', 'src/sound.c', proto_src,
  dependencies : [wayland_client, wayland_egl, egl, glesv2, m, mpv])

# Control panel (Python + GTK4): `hyperion-rain`, plus a launcher entry.
install_data('gui/hyperion-rain.py', install_dir : get_option('bindir'),
  rename : 'hyperion-rain', install_mode : 'rwxr-xr-x')
install_data('gui/assets/nyabi-cat.png', install_dir : get_option('datadir') / 'gl-overlay' / 'gui')
# Exec gets the absolute path: launchers started by Hyprland may not have ~/.local/bin on PATH.
# The .desktop file and the icon are named after the panel's app id, so docks and taskbars match them.
configure_file(input : 'gui/hyperion-rain.desktop.in', output : 'org.nyabi.hyperion_rain.desktop',
  configuration : {'BINDIR' : get_option('prefix') / get_option('bindir')},
  install_dir : get_option('datadir') / 'applications')
# App icon (regenerate with tools/make-icon.py).
install_data('data/icons/hyperion-rain.svg',
  install_dir : get_option('datadir') / 'icons' / 'hicolor' / 'scalable' / 'apps',
  rename : 'org.nyabi.hyperion_rain.svg')
