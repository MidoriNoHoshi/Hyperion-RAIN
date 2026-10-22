/*
 * Control plane: a line-based UNIX socket at $XDG_RUNTIME_DIR/gl-overlay.sock
 * plus inotify hot-reload of the active shader file.
 *
 *   gl-overlay ctl set uIntensity 0.6
 *   echo 'toggle' | socat - UNIX-CONNECT:$XDG_RUNTIME_DIR/gl-overlay.sock
 */
#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <math.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/inotify.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#include "overlay.h"

static const char *help_text =
	"commands:\n"
	"  load <effect|path>    rain, snow, anime, sakura, anime-sakura or a .frag file\n"
	"  effects               list the effects that load can find\n"
	"  reload                recompile the current shader\n"
	"  set <name> <float>    set a shader uniform (or 'opacity')\n"
	"  add <name> <delta>    nudge a uniform, e.g. add uRain 0.2 (for keybinds)\n"
	"  get                   list parameters\n"
	"  show | hide | toggle  overlay visibility\n"
	"  pause | resume        freeze/unfreeze time (paused = no GPU work)\n"
	"  toggle-pause          pause <-> resume\n"
	"  fps <n>               cap frame rate (0 = monitor refresh)\n"
	"  sound [on|off|toggle] soundtrack; no argument prints what plays\n"
	"  sound <name|path>     play your own track instead (any format mpv reads)\n"
	"  sound default         back to the effect's own sound\n"
	"  volume <0..1>         soundtrack volume (also: set/add volume)\n"
	"  status                print state\n"
	"  quit                  stop the daemon\n";

static void default_socket_path(char *buf, size_t len)
{
	const char *dir = getenv("XDG_RUNTIME_DIR");
	snprintf(buf, len, "%s/gl-overlay.sock", dir ? dir : "/tmp");
}

bool ipc_init(struct overlay *ov)
{
	if (!ov->ipc_path[0])
		default_socket_path(ov->ipc_path, sizeof ov->ipc_path);

	struct sockaddr_un addr = { .sun_family = AF_UNIX };
	snprintf(addr.sun_path, sizeof addr.sun_path, "%s", ov->ipc_path);

	/* Refuse to start twice; clean up a stale socket otherwise. */
	int probe = socket(AF_UNIX, SOCK_STREAM, 0);
	if (connect(probe, (struct sockaddr *)&addr, sizeof addr) == 0) {
		fprintf(stderr, "gl-overlay: already running (%s)\n", ov->ipc_path);
		close(probe);
		return false;
	}
	close(probe);
	unlink(ov->ipc_path);

	ov->ipc_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
	if (bind(ov->ipc_fd, (struct sockaddr *)&addr, sizeof addr) < 0 ||
	    listen(ov->ipc_fd, 8) < 0) {
		fprintf(stderr, "gl-overlay: cannot bind %s: %s\n", ov->ipc_path, strerror(errno));
		return false;
	}
	return true;
}

void ipc_finish(struct overlay *ov)
{
	if (ov->ipc_fd > 0) {
		close(ov->ipc_fd);
		unlink(ov->ipc_path);
	}
	if (ov->inotify_fd > 0)
		close(ov->inotify_fd);
}

static void reply(int fd, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static void reply(int fd, const char *fmt, ...)
{
	char buf[4096];
	va_list ap;
	va_start(ap, fmt);
	int n = vsnprintf(buf, sizeof buf, fmt, ap);
	va_end(ap);
	if (n > 0 && write(fd, buf, n < (int)sizeof buf ? n : (int)sizeof buf - 1) < 0)
		return;
}

static void reply_effect(const char *name, const char *path, void *data)
{
	reply(*(int *)data, "%s %s\n", name, path);
}

static void handle_command(struct overlay *ov, int fd, char *line)
{
	char *save = NULL;
	char *cmd = strtok_r(line, " \t\r\n", &save);
	char *a1, *a2 = NULL;
	if (cmd && (!strcmp(cmd, "sound") || !strcmp(cmd, "load"))) {
		/* the rest of the line is one argument: file names may have spaces */
		a1 = save + strspn(save, " \t");
		size_t len = strlen(a1);
		while (len && strchr(" \t\r\n", a1[len - 1]))
			a1[--len] = '\0';
		if (!len)
			a1 = NULL;
	} else {
		a1 = strtok_r(NULL, " \t\r\n", &save);
		a2 = strtok_r(NULL, " \t\r\n", &save);
	}

	if (!cmd || !strcmp(cmd, "help")) {
		reply(fd, "%s", help_text);
	} else if (!strcmp(cmd, "effects")) {
		shader_list(reply_effect, &fd);
	} else if (!strcmp(cmd, "load") && a1) {
		char abs[PATH_MAX];
		const char *path = shader_resolve(a1, abs) ? abs : a1;
		if (shader_load(ov, path)) {
			watch_shader(ov);
			outputs_schedule_all(ov);
			reply(fd, "ok\n");
		} else {
			reply(fd, "error: failed to load %s (see daemon log)\n", a1);
		}
	} else if (!strcmp(cmd, "reload")) {
		bool ok = shader_load(ov, ov->shader_path);
		outputs_schedule_all(ov);
		reply(fd, ok ? "ok\n" : "error: compile failed (see daemon log)\n");
	} else if (!strcmp(cmd, "sound")) {
		if (!sound_available()) {
			reply(fd, "error: built without sound (libmpv)\n");
			return;
		}
		if (!a1) {
			/* fall through to the report below */
		} else if (!strcmp(a1, "on") || !strcmp(a1, "off") || !strcmp(a1, "toggle")) {
			ov->sound_on = !strcmp(a1, "on") ? true : !strcmp(a1, "off") ? false : !ov->sound_on;
		} else if (!strcmp(a1, "default")) {
			ov->sound_custom[0] = '\0';
		} else {
			char abs[PATH_MAX];
			if (!sound_resolve(a1, abs)) {
				reply(fd, "error: %s: no such sound or audio file\n", a1);
				return;
			}
			snprintf(ov->sound_custom, sizeof ov->sound_custom, "%s", abs);
			ov->sound_on = true;
		}
		sound_update(ov, true);
		const char *now = sound_current(ov);
		reply(fd, "sound %s\n", !ov->sound_on ? "off" : now ? now : "none (this effect has no sound)");
	} else if (!strcmp(cmd, "volume") && a1) {
		ov->volume = fminf(fmaxf(strtof(a1, NULL), 0.0f), 1.0f);
		sound_update(ov, true);
		reply(fd, "volume %g\n", ov->volume);
	} else if (!strcmp(cmd, "set") && a1 && a2) {
		float v = strtof(a2, NULL);
		if (!strcmp(a1, "opacity"))
			ov->opacity = v;
		else if (!strcmp(a1, "volume"))
			ov->volume = fminf(fmaxf(v, 0.0f), 1.0f);
		else
			param_set(ov, a1, v);
		outputs_schedule_all(ov);
		reply(fd, "ok\n");
	} else if (!strcmp(cmd, "add") && a1 && a2) {
		float v;
		if (!strcmp(a1, "opacity")) {
			ov->opacity = v = fminf(fmaxf(ov->opacity + strtof(a2, NULL), 0.0f), 1.0f);
		} else if (!strcmp(a1, "volume")) {
			ov->volume = v = fminf(fmaxf(ov->volume + strtof(a2, NULL), 0.0f), 1.0f);
		} else {
			/* a non-negative value stops at 0 (rain can't go below dry), wind may go negative */
			float old = param_get(ov, a1, 0.0f);
			v = old + strtof(a2, NULL);
			if (old >= 0.0f && v < 0.0f)
				v = 0.0f;
			param_set(ov, a1, v);
		}
		outputs_schedule_all(ov);
		reply(fd, "%s %g\n", a1, v);
	} else if (!strcmp(cmd, "get")) {
		reply(fd, "opacity %g\nvolume %g\n", ov->opacity, ov->volume);
		for (int i = 0; i < ov->n_params; i++)
			reply(fd, "%s %g\n", ov->params[i].name, ov->params[i].value);
	} else if (!strcmp(cmd, "show") || !strcmp(cmd, "hide") || !strcmp(cmd, "toggle")) {
		ov->visible = !strcmp(cmd, "show") ? true :
		              !strcmp(cmd, "hide") ? false : !ov->visible;
		ov->last_frame = 0; /* don't jump time forward after a hide */
		outputs_schedule_all(ov);
		reply(fd, "%s\n", ov->visible ? "visible" : "hidden");
	} else if (!strcmp(cmd, "pause") || !strcmp(cmd, "resume") || !strcmp(cmd, "toggle-pause")) {
		ov->paused = !strcmp(cmd, "toggle-pause") ? !ov->paused : !strcmp(cmd, "pause");
		ov->last_frame = 0;
		outputs_schedule_all(ov);
		reply(fd, "%s\n", ov->paused ? "paused" : "running");
	} else if (!strcmp(cmd, "fps") && a1) {
		float fps = strtof(a1, NULL);
		ov->min_frame_interval = fps > 0 ? 1.0 / fps : 0;
		outputs_schedule_all(ov);
		reply(fd, "ok\n");
	} else if (!strcmp(cmd, "status")) {
		int n = 0;
		struct output *out;
		wl_list_for_each(out, &ov->outputs, link)
			n += out->configured;
		const char *snd = sound_current(ov);
		reply(fd, "shader %s\nvisible %d\npaused %d\nopacity %g\nfps_cap %g\noutputs %d\ntime %.2f\n"
		      "sound %s\nvolume %g\n",
		      ov->shader_path, ov->visible, ov->paused, ov->opacity,
		      ov->min_frame_interval > 0 ? 1.0 / ov->min_frame_interval : 0, n, ov->time,
		      !ov->sound_on ? "off" : snd ? snd : "none", ov->volume);
	} else if (!strcmp(cmd, "quit")) {
		ov->running = false;
		reply(fd, "bye\n");
	} else {
		reply(fd, "error: unknown command '%s'\n%s", cmd, help_text);
	}
}

void ipc_accept(struct overlay *ov)
{
	int fd;
	while ((fd = accept4(ov->ipc_fd, NULL, NULL, SOCK_CLOEXEC)) >= 0) {
		/* Clients send one short line right away; don't let a stuck one hang us. */
		struct timeval tv = { .tv_usec = 200000 };
		setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
		char buf[1024];
		ssize_t n = read(fd, buf, sizeof buf - 1);
		if (n > 0) {
			buf[n] = '\0';
			handle_command(ov, fd, buf);
			sound_update(ov, true); /* follows pause/hide/load/set at once */
		}
		close(fd);
	}
}

int ipc_client(const char *socket_path, int argc, char **argv)
{
	char path[108];
	if (socket_path)
		snprintf(path, sizeof path, "%s", socket_path);
	else
		default_socket_path(path, sizeof path);

	struct sockaddr_un addr = { .sun_family = AF_UNIX };
	snprintf(addr.sun_path, sizeof addr.sun_path, "%s", path);
	int fd = socket(AF_UNIX, SOCK_STREAM, 0);
	if (connect(fd, (struct sockaddr *)&addr, sizeof addr) < 0) {
		fprintf(stderr, "gl-overlay: daemon not running (%s)\n", path);
		return 1;
	}

	char line[1024] = "";
	for (int i = 0; i < argc; i++) {
		/* `load` / `sound` paths get resolved here, relative to the caller's cwd. */
		char abs[PATH_MAX];
		const char *arg = argv[i];
		bool sound_path = !strcmp(argv[0], "sound") && (strchr(arg, '/') || strchr(arg, '.'));
		if (i == 1 && (!strcmp(argv[0], "load") || sound_path) && realpath(arg, abs))
			arg = abs;
		strncat(line, arg, sizeof line - strlen(line) - 2);
		strncat(line, i + 1 < argc ? " " : "\n", sizeof line - strlen(line) - 1);
	}
	if (write(fd, line, strlen(line)) < 0)
		return 1;
	shutdown(fd, SHUT_WR);

	char buf[4096];
	ssize_t n;
	while ((n = read(fd, buf, sizeof buf)) > 0)
		fwrite(buf, 1, n, stdout);
	close(fd);
	return 0;
}

/* -------------------------------------------------------------- inotify */

/*
 * Watch the shader's *directory*: most editors save via write-to-temp +
 * rename, which would silently orphan a watch on the file itself.
 */
void watch_shader(struct overlay *ov)
{
	if (ov->inotify_fd <= 0)
		ov->inotify_fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
	if (ov->inotify_wd > 0)
		inotify_rm_watch(ov->inotify_fd, ov->inotify_wd);

	char dir[4096];
	snprintf(dir, sizeof dir, "%s", ov->shader_path);
	ov->inotify_wd = inotify_add_watch(ov->inotify_fd, dirname(dir),
	                                   IN_CLOSE_WRITE | IN_MOVED_TO);
}

void watch_handle(struct overlay *ov)
{
	char buf[4096] __attribute__((aligned(__alignof__(struct inotify_event))));
	char base_buf[4096];
	snprintf(base_buf, sizeof base_buf, "%s", ov->shader_path);
	const char *base = basename(base_buf);
	bool hit = false;

	ssize_t n;
	while ((n = read(ov->inotify_fd, buf, sizeof buf)) > 0) {
		for (char *p = buf; p < buf + n;) {
			struct inotify_event *ev = (struct inotify_event *)p;
			if (ev->len && !strcmp(ev->name, base))
				hit = true;
			p += sizeof *ev + ev->len;
		}
	}
	if (hit) {
		shader_load(ov, ov->shader_path); /* on error the old shader keeps running */
		outputs_schedule_all(ov);
	}
}
