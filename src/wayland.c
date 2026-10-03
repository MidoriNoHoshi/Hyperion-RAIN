/*
 * Wayland side: registry, per-output layer-shell surfaces, input passthrough
 * and frame-callback pacing.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/timerfd.h>
#include <unistd.h>

#include "overlay.h"
#include "wlr-layer-shell-unstable-v1-client-protocol.h"

static void output_create_surface(struct output *out);
static void output_destroy_surface(struct output *out);

/* ---------------------------------------------------------------- frames */

static void frame_done(void *data, struct wl_callback *cb, uint32_t time)
{
	struct output *out = data;
	struct overlay *ov = out->ov;
	wl_callback_destroy(cb);
	out->frame_cb = NULL;

	/* FPS cap: if the compositor is faster than we want, park until due. */
	if (ov->min_frame_interval > 0 && !out->dirty) {
		double wait = out->last_render + ov->min_frame_interval - now_seconds();
		if (wait > 0.002) {
			out->waiting = true;
			struct itimerspec its = {
				.it_value.tv_sec = (time_t)wait,
				.it_value.tv_nsec = (long)((wait - (time_t)wait) * 1e9),
			};
			timerfd_settime(ov->timer_fd, 0, &its, NULL);
			return;
		}
	}
	output_render(ov, out);
}

void timer_handle(struct overlay *ov)
{
	uint64_t expirations;
	if (read(ov->timer_fd, &expirations, sizeof expirations) < 0)
		return;

	double now = now_seconds(), next = 0;
	struct output *out;
	wl_list_for_each(out, &ov->outputs, link) {
		if (!out->waiting)
			continue;
		double wait = out->last_render + ov->min_frame_interval - now;
		if (wait <= 0.002) {
			out->waiting = false;
			output_render(ov, out);
		} else if (next == 0 || wait < next) {
			next = wait;
		}
	}
	if (next > 0) {
		struct itimerspec its = {
			.it_value.tv_sec = (time_t)next,
			.it_value.tv_nsec = (long)((next - (time_t)next) * 1e9),
		};
		timerfd_settime(ov->timer_fd, 0, &its, NULL);
	}
}

static const struct wl_callback_listener frame_listener = {
	.done = frame_done,
};

/* Attach a frame callback; the next commit (eglSwapBuffers) sends it. */
void output_request_frame(struct output *out)
{
	if (out->frame_cb)
		return;
	out->frame_cb = wl_surface_frame(out->surface);
	wl_callback_add_listener(out->frame_cb, &frame_listener, out);
}

/* Ask for a frame callback; render happens when the compositor says so. */
void output_schedule(struct output *out)
{
	if (!out->configured || out->frame_cb)
		return;
	if (out->waiting) { /* parked by the fps cap; render now instead */
		out->waiting = false;
		output_render(out->ov, out);
		return;
	}
	out->frame_cb = wl_surface_frame(out->surface);
	wl_callback_add_listener(out->frame_cb, &frame_listener, out);
	wl_surface_commit(out->surface);
}

void outputs_schedule_all(struct overlay *ov)
{
	struct output *out;
	wl_list_for_each(out, &ov->outputs, link) {
		out->dirty = true;
		output_schedule(out);
	}
}

/* ---------------------------------------------------------- layer surface */

static void layer_configure(void *data, struct zwlr_layer_surface_v1 *ls,
                            uint32_t serial, uint32_t w, uint32_t h)
{
	struct output *out = data;
	struct overlay *ov = out->ov;

	zwlr_layer_surface_v1_ack_configure(ls, serial);
	out->width = w;
	out->height = h;

	int bw = (int)w * out->scale, bh = (int)h * out->scale;
	if (!out->egl_window) {
		out->egl_window = wl_egl_window_create(out->surface, bw, bh);
		out->egl_surface = eglCreatePlatformWindowSurface(
			ov->egl_display, ov->egl_config, out->egl_window, NULL);
		if (out->egl_surface == EGL_NO_SURFACE) {
			fprintf(stderr, "gl-overlay: eglCreatePlatformWindowSurface failed (0x%x)\n",
			        eglGetError());
			return;
		}
		eglMakeCurrent(ov->egl_display, out->egl_surface, out->egl_surface,
		               ov->egl_context);
		/* We pace with frame callbacks, never block in eglSwapBuffers. */
		eglSwapInterval(ov->egl_display, 0);
	} else {
		wl_egl_window_resize(out->egl_window, bw, bh, 0, 0);
	}

	out->configured = true;
	out->dirty = true;
	if (!out->frame_cb)
		output_render(ov, out);
}

static void layer_closed(void *data, struct zwlr_layer_surface_v1 *ls)
{
	output_destroy_surface(data);
}

static const struct zwlr_layer_surface_v1_listener layer_listener = {
	.configure = layer_configure,
	.closed = layer_closed,
};

static void output_create_surface(struct output *out)
{
	struct overlay *ov = out->ov;
	if (out->surface || !ov->layer_shell || !ov->egl_context)
		return;
	if (ov->only_output && strcmp(ov->only_output, out->name) != 0)
		return;

	out->surface = wl_compositor_create_surface(ov->compositor);
	wl_surface_set_buffer_scale(out->surface, out->scale);

	/*
	 * Input passthrough. NOTE: set_input_region(NULL) means "infinite"
	 * (accept input everywhere) — the opposite of what we want. An *empty*
	 * region is what makes every click/scroll fall through to the windows
	 * below.
	 */
	struct wl_region *empty = wl_compositor_create_region(ov->compositor);
	wl_surface_set_input_region(out->surface, empty);
	wl_region_destroy(empty);
	/* Never claim an opaque region: we are translucent everywhere. */

	out->layer_surface = zwlr_layer_shell_v1_get_layer_surface(
		ov->layer_shell, out->surface, out->wl_output,
		ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY, "gl-overlay");

	zwlr_layer_surface_v1_set_anchor(out->layer_surface,
		ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP | ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM |
		ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT | ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT);
	zwlr_layer_surface_v1_set_size(out->layer_surface, 0, 0); /* = full output */
	/* -1: ignore other surfaces' exclusive zones, cover bars too. */
	zwlr_layer_surface_v1_set_exclusive_zone(out->layer_surface, -1);
	zwlr_layer_surface_v1_set_keyboard_interactivity(out->layer_surface,
		ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE);
	zwlr_layer_surface_v1_add_listener(out->layer_surface, &layer_listener, out);

	/* Initial empty commit triggers the first configure. */
	wl_surface_commit(out->surface);
}

static void output_destroy_surface(struct output *out)
{
	struct overlay *ov = out->ov;
	if (out->frame_cb) {
		wl_callback_destroy(out->frame_cb);
		out->frame_cb = NULL;
	}
	if (out->egl_surface) {
		eglMakeCurrent(ov->egl_display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
		eglDestroySurface(ov->egl_display, out->egl_surface);
		out->egl_surface = EGL_NO_SURFACE;
	}
	if (out->egl_window) {
		wl_egl_window_destroy(out->egl_window);
		out->egl_window = NULL;
	}
	if (out->layer_surface) {
		zwlr_layer_surface_v1_destroy(out->layer_surface);
		out->layer_surface = NULL;
	}
	if (out->surface) {
		wl_surface_destroy(out->surface);
		out->surface = NULL;
	}
	out->configured = false;
}

/* ---------------------------------------------------------------- outputs */

static void output_geometry(void *d, struct wl_output *o, int32_t x, int32_t y,
	int32_t pw, int32_t ph, int32_t sp, const char *make, const char *model, int32_t t) {}
static void output_mode(void *d, struct wl_output *o, uint32_t f, int32_t w,
	int32_t h, int32_t r) {}
static void output_description(void *d, struct wl_output *o, const char *desc) {}

static void output_scale(void *data, struct wl_output *o, int32_t scale)
{
	struct output *out = data;
	if (out->scale == scale)
		return;
	out->scale = scale;
	if (out->surface) {
		wl_surface_set_buffer_scale(out->surface, scale);
		if (out->egl_window)
			wl_egl_window_resize(out->egl_window, out->width * scale,
			                     out->height * scale, 0, 0);
		out->dirty = true;
		output_schedule(out);
	}
}

static void output_name(void *data, struct wl_output *o, const char *name)
{
	struct output *out = data;
	snprintf(out->name, sizeof out->name, "%s", name);
}

static void output_done(void *data, struct wl_output *o)
{
	output_create_surface(data); /* no-op if already created / filtered */
}

static const struct wl_output_listener output_listener = {
	.geometry = output_geometry,
	.mode = output_mode,
	.done = output_done,
	.scale = output_scale,
	.name = output_name,
	.description = output_description,
};

/* --------------------------------------------------------------- registry */

static void registry_global(void *data, struct wl_registry *reg, uint32_t name,
                            const char *iface, uint32_t version)
{
	struct overlay *ov = data;

	if (strcmp(iface, wl_compositor_interface.name) == 0) {
		ov->compositor = wl_registry_bind(reg, name, &wl_compositor_interface,
		                                  version < 4 ? version : 4);
	} else if (strcmp(iface, zwlr_layer_shell_v1_interface.name) == 0) {
		ov->layer_shell = wl_registry_bind(reg, name, &zwlr_layer_shell_v1_interface,
		                                   version < 4 ? version : 4);
	} else if (strcmp(iface, wl_output_interface.name) == 0) {
		if (version < 4) {
			fprintf(stderr, "gl-overlay: wl_output v%u too old (need 4)\n", version);
			return;
		}
		struct output *out = calloc(1, sizeof *out);
		out->ov = ov;
		out->global_name = name;
		out->scale = 1;
		out->wl_output = wl_registry_bind(reg, name, &wl_output_interface, 4);
		wl_output_add_listener(out->wl_output, &output_listener, out);
		wl_list_insert(&ov->outputs, &out->link);
	}
}

static void registry_global_remove(void *data, struct wl_registry *reg, uint32_t name)
{
	struct overlay *ov = data;
	struct output *out, *tmp;
	wl_list_for_each_safe(out, tmp, &ov->outputs, link) {
		if (out->global_name != name)
			continue;
		output_destroy_surface(out);
		wl_output_release(out->wl_output);
		wl_list_remove(&out->link);
		free(out);
	}
}

static const struct wl_registry_listener registry_listener = {
	.global = registry_global,
	.global_remove = registry_global_remove,
};

bool wl_init(struct overlay *ov)
{
	wl_list_init(&ov->outputs);

	ov->display = wl_display_connect(NULL);
	if (!ov->display) {
		fprintf(stderr, "gl-overlay: cannot connect to a Wayland display\n");
		return false;
	}
	ov->registry = wl_display_get_registry(ov->display);
	wl_registry_add_listener(ov->registry, &registry_listener, ov);
	wl_display_roundtrip(ov->display); /* globals */
	wl_display_roundtrip(ov->display); /* output names/scales */

	if (!ov->compositor || !ov->layer_shell) {
		fprintf(stderr, "gl-overlay: compositor lacks wl_compositor or "
		                "zwlr_layer_shell_v1 (GNOME is not supported)\n");
		return false;
	}
	return true;
}

/* Called once EGL is up: outputs that already sent .done get their surface. */
void wl_create_surfaces(struct overlay *ov)
{
	struct output *out;
	wl_list_for_each(out, &ov->outputs, link)
		output_create_surface(out);
}

void wl_destroy_outputs(struct overlay *ov)
{
	if (!ov->outputs.next) /* wl_init never ran */
		return;
	struct output *out, *tmp;
	wl_list_for_each_safe(out, tmp, &ov->outputs, link) {
		output_destroy_surface(out);
		wl_output_release(out->wl_output);
		wl_list_remove(&out->link);
		free(out);
	}
}

void wl_finish(struct overlay *ov)
{
	if (ov->layer_shell)
		zwlr_layer_shell_v1_destroy(ov->layer_shell);
	if (ov->compositor)
		wl_compositor_destroy(ov->compositor);
	if (ov->registry)
		wl_registry_destroy(ov->registry);
	if (ov->display)
		wl_display_disconnect(ov->display);
}
