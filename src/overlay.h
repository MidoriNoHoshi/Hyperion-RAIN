#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <wayland-client.h>
#include <wayland-egl.h>
#include <EGL/egl.h>
#include <GLES3/gl3.h>

#define MAX_PARAMS 32

struct output {
	struct wl_list link;
	struct overlay *ov;
	uint32_t global_name;
	struct wl_output *wl_output;
	char name[64];
	int32_t scale;

	struct wl_surface *surface;
	struct zwlr_layer_surface_v1 *layer_surface;
	struct wl_egl_window *egl_window;
	EGLSurface egl_surface;
	struct wl_callback *frame_cb;
	uint32_t width, height; /* logical size from configure */
	bool configured;
	bool dirty;             /* needs a redraw even if paused */
	bool waiting;           /* frame came early under an fps cap */
	double last_render;
};

struct param {
	char name[64];
	float value;
	bool overridden; /* set via IPC: survives shader reloads */
};

struct overlay {
	/* wayland */
	struct wl_display *display;
	struct wl_registry *registry;
	struct wl_compositor *compositor;
	struct zwlr_layer_shell_v1 *layer_shell;
	struct wl_list outputs;
	const char *only_output; /* NULL = all outputs */

	/* egl / gl */
	EGLDisplay egl_display;
	EGLConfig egl_config;
	EGLContext egl_context;
	GLuint program, vao;
	GLuint channels[4];
	int channel_res[4][2];

	/* shader state */
	char shader_path[4096];
	struct param params[MAX_PARAMS];
	int n_params;
	float opacity;
	bool visible;
	bool paused;
	double time, time_offset, last_frame;
	int frame;
	double min_frame_interval; /* 0 = uncapped (monitor refresh) */

	/* ipc / file watching */
	int ipc_fd;
	char ipc_path[108]; /* sizeof sockaddr_un.sun_path */
	int inotify_fd, inotify_wd;
	int timer_fd;

	bool running;
};

/* wayland.c */
bool wl_init(struct overlay *ov);
void wl_create_surfaces(struct overlay *ov);
void wl_destroy_outputs(struct overlay *ov);
void wl_finish(struct overlay *ov);
void timer_handle(struct overlay *ov);
void output_request_frame(struct output *out);
void output_schedule(struct output *out);
void outputs_schedule_all(struct overlay *ov);

/* render.c */
bool gl_init(struct overlay *ov, bool headless);
void draw_frame(struct overlay *ov, int w, int h, double dt);
void gl_finish(struct overlay *ov);
bool shader_load(struct overlay *ov, const char *path);
void output_render(struct overlay *ov, struct output *out);
void param_set(struct overlay *ov, const char *name, float value);
double now_seconds(void);

/* ipc.c */
bool ipc_init(struct overlay *ov);
void ipc_finish(struct overlay *ov);
void ipc_accept(struct overlay *ov);
int ipc_client(const char *socket_path, int argc, char **argv);
void watch_shader(struct overlay *ov);
void watch_handle(struct overlay *ov);
