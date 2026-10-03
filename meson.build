project('gl-overlay', 'c',
  version : '0.1.0',
  license : 'MIT',
  default_options : ['c_std=c11', 'warning_level=2', 'buildtype=release'])

add_project_arguments('-D_GNU_SOURCE', '-Wno-unused-parameter',
  '-DGL_OVERLAY_DATADIR="@0@"'.format(get_option('prefix') / get_option('datadir') / 'gl-overlay'),
  language : 'c')

wayland_client = dependency('wayland-client')
wayland_egl    = dependency('wayland-egl')
egl            = dependency('egl')
glesv2         = dependency('glesv2')
wayland_protos = dependency('wayland-protocols')
m              = meson.get_compiler('c').find_library('m')

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
  'src/main.c', 'src/wayland.c', 'src/render.c', 'src/ipc.c', proto_src,
  dependencies : [wayland_client, wayland_egl, egl, glesv2, m],
  install : true)

install_subdir('shaders', install_dir : get_option('datadir') / 'gl-overlay')

# Headless single-frame renderer for previews / shader development.
executable('gl-overlay-still',
  'src/still.c', 'src/render.c', 'src/wayland.c', proto_src,
  dependencies : [wayland_client, wayland_egl, egl, glesv2, m])
