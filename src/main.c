/*
 * gl-overlay — fullscreen, click-through GLSL shader overlay for Wayland.
 */
#include <errno.h>
#include <getopt.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/timerfd.h>
#include <unistd.h>

#include "overlay.h"

#ifndef GL_OVERLAY_DATADIR
#define GL_OVERLAY_DATADIR "/usr/local/share/gl-overlay"
#endif

static volatile sig_atomic_t got_signal;
static void on_signal(int sig) { got_signal = sig; }

static void usage(FILE *f)
{
	fprintf(f,
		"Hyperion-RAIN %s · Hyprland effects overlay · a NyaBi project · nyabi.org\n"
		"\n"
		"usage: gl-overlay [options]            run the daemon\n"
		"       gl-overlay ctl <command> [args]  control a running daemon\n"
		"\n"
		"options:\n"
		"  -s, --shader EFFECT   effect name (rain, snow, …) or a .frag path (default: rain)\n"
		"  -o, --output NAME     only cover this output (e.g. DP-1)\n"
		"  -a, --opacity F       global opacity 0..1 (default 1)\n"
		"  -f, --fps N           frame rate cap (default: monitor refresh)\n"
		"  -p, --param NAME=F    preset a shader uniform (repeatable)\n"
		"  -m, --sound SPEC      play a soundtrack: on (the effect's own, e.g. rain),\n"
		"                        off (default), a sound name or an audio file\n"
		"      --volume F        soundtrack volume 0..1 (default 0.6)\n"
		"  -S, --socket PATH     IPC socket path\n"
		"  -h, --help\n"
		"  -v, --version\n"
		"\n"
		"run `gl-overlay ctl help` for control commands.\n", GL_OVERLAY_VERSION);
}

int main(int argc, char **argv)
{
	const char *socket_path = NULL;

	if (argc >= 2 && !strcmp(argv[1], "ctl")) {
		if (argc < 3) {
			char *help[] = { "help" };
			return ipc_client(getenv("GL_OVERLAY_SOCKET"), 1, help);
		}
		return ipc_client(getenv("GL_OVERLAY_SOCKET"), argc - 2, argv + 2);
	}

	struct overlay ov = {
		.opacity = 1.0f,
		.visible = true,
		.running = true,
		.ipc_fd = -1,
		.inotify_fd = -1,
		.timer_fd = -1,
		.volume = 0.6f,
	};
	const char *shader = NULL;

	static const struct option opts[] = {
		{ "shader",  required_argument, 0, 's' },
		{ "output",  required_argument, 0, 'o' },
		{ "opacity", required_argument, 0, 'a' },
		{ "fps",     required_argument, 0, 'f' },
		{ "param",   required_argument, 0, 'p' },
		{ "socket",  required_argument, 0, 'S' },
		{ "sound",   required_argument, 0, 'm' },
		{ "volume",  required_argument, 0, 'V' },
		{ "help",    no_argument,       0, 'h' },
		{ "version", no_argument,       0, 'v' },
		{ 0 },
	};
	int c;
	const char *sound = NULL;
	while ((c = getopt_long(argc, argv, "s:o:a:f:p:S:m:hv", opts, NULL)) != -1) {
		switch (c) {
		case 's': shader = optarg; break;
		case 'o': ov.only_output = optarg; break;
		case 'a': ov.opacity = strtof(optarg, NULL); break;
		case 'f': {
			float fps = strtof(optarg, NULL);
			ov.min_frame_interval = fps > 0 ? 1.0 / fps : 0;
			break;
		}
		case 'p': {
			char *eq = strchr(optarg, '=');
			if (!eq) { usage(stderr); return 1; }
			*eq = '\0';
			param_set(&ov, optarg, strtof(eq + 1, NULL));
			break;
		}
		case 'S': socket_path = optarg; break;
		case 'm': sound = optarg; break;
		case 'V': ov.volume = strtof(optarg, NULL); break;
		case 'h': usage(stdout); return 0;
		case 'v': printf("Hyperion-RAIN (gl-overlay) %s · a NyaBi project\n", GL_OVERLAY_VERSION); return 0;
		default:  usage(stderr); return 1;
		}
	}
	if (!socket_path)
		socket_path = getenv("GL_OVERLAY_SOCKET");
	if (socket_path)
		snprintf(ov.ipc_path, sizeof ov.ipc_path, "%s", socket_path);

	char shader_buf[PATH_MAX];
	if (!shader_resolve(shader ? shader : "rain", shader_buf)) {
		fprintf(stderr, "gl-overlay: %s: no such effect or shader file\n", shader ? shader : "rain");
		return 1;
	}

	if (sound && strcmp(sound, "off") != 0) {
		if (!sound_available()) {
			fprintf(stderr, "gl-overlay: built without sound (libmpv); ignoring --sound\n");
		} else if (strcmp(sound, "on") != 0) {
			if (!sound_resolve(sound, ov.sound_custom)) {
				fprintf(stderr, "gl-overlay: %s: no such sound or audio file\n", sound);
				return 1;
			}
			ov.sound_on = true;
		} else {
			ov.sound_on = true;
		}
	}

	int ret = 1;
	if (!ipc_init(&ov))
		goto out;
	if (!wl_init(&ov) || !gl_init(&ov, false))
		goto out;
	if (!shader_load(&ov, shader_buf))
		goto out;
	watch_shader(&ov);
	sound_update(&ov, true);
	ov.timer_fd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
	wl_create_surfaces(&ov);

	struct sigaction sa = { .sa_handler = on_signal };
	sigaction(SIGINT, &sa, NULL);
	sigaction(SIGTERM, &sa, NULL);
	signal(SIGPIPE, SIG_IGN);

	enum { FD_WL, FD_IPC, FD_INOTIFY, FD_TIMER, FD_COUNT };
	struct pollfd fds[FD_COUNT] = {
		[FD_WL]      = { .fd = wl_display_get_fd(ov.display), .events = POLLIN },
		[FD_IPC]     = { .fd = ov.ipc_fd,     .events = POLLIN },
		[FD_INOTIFY] = { .fd = ov.inotify_fd, .events = POLLIN },
		[FD_TIMER]   = { .fd = ov.timer_fd,   .events = POLLIN },
	};

	while (ov.running && !got_signal) {
		while (wl_display_prepare_read(ov.display) != 0)
			wl_display_dispatch_pending(ov.display);
		if (wl_display_flush(ov.display) < 0 && errno != EAGAIN) {
			wl_display_cancel_read(ov.display);
			break;
		}

		if (poll(fds, FD_COUNT, -1) < 0) {
			wl_display_cancel_read(ov.display);
			if (errno == EINTR)
				continue;
			break;
		}

		if (fds[FD_WL].revents & POLLIN) {
			if (wl_display_read_events(ov.display) < 0)
				break;
		} else {
			wl_display_cancel_read(ov.display);
		}
		if (fds[FD_WL].revents & (POLLERR | POLLHUP))
			break;
		if (wl_display_dispatch_pending(ov.display) < 0)
			break;

		if (fds[FD_IPC].revents & POLLIN)
			ipc_accept(&ov);
		if (fds[FD_INOTIFY].revents & POLLIN)
			watch_handle(&ov);
		if (fds[FD_TIMER].revents & POLLIN)
			timer_handle(&ov);
	}
	ret = 0;

out:
	sound_finish(&ov);
	/* EGL surfaces -> EGL context/display -> Wayland connection. */
	wl_destroy_outputs(&ov);
	gl_finish(&ov);
	wl_finish(&ov);
	if (ov.timer_fd >= 0)
		close(ov.timer_fd);
	ipc_finish(&ov);
	return ret;
}
