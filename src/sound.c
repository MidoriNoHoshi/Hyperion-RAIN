/*
 * Soundtrack: one looping audio file played through libmpv.
 *
 * Each effect may name a default sound with `#pragma sound <name> [param]`;
 * <name> is looked up as sounds/<name>.{ogg,opus,flac,wav,mp3} in the same
 * places as the shaders. When [param] is given (e.g. uRain), loudness follows
 * that parameter and the same slow storm drift the shader uses, so the rain
 * swells in a downpour and fades in a lull. Sound is off until asked for:
 * `-m on`, `ctl sound on`, or a file of your own with `ctl sound <path>`.
 */
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "overlay.h"

#ifdef HAVE_MPV
#include <mpv/client.h>
#endif

#ifndef GL_OVERLAY_DATADIR
#define GL_OVERLAY_DATADIR "/usr/local/share/gl-overlay"
#endif

static const char *exts[] = { "ogg", "opus", "flac", "wav", "mp3" };

const char *sound_resolve(const char *name, char *buf)
{
	if (strchr(name, '/') || strchr(name, '.'))
		return realpath(name, buf);
	char user[PATH_MAX - 64], cand[PATH_MAX];
	const char *xdg = getenv("XDG_DATA_HOME"), *home = getenv("HOME");
	if (xdg && *xdg)
		snprintf(user, sizeof user, "%s/gl-overlay/sounds", xdg);
	else
		snprintf(user, sizeof user, "%s/.local/share/gl-overlay/sounds", home ? home : "");
	const char *dirs[] = { "sounds", user, GL_OVERLAY_DATADIR "/sounds" };
	for (size_t d = 0; d < sizeof dirs / sizeof *dirs; d++)
		for (size_t e = 0; e < sizeof exts / sizeof *exts; e++) {
			snprintf(cand, sizeof cand, "%s/%s.%s", dirs[d], name, exts[e]);
			if (access(cand, R_OK) == 0 && realpath(cand, buf))
				return buf;
		}
	return NULL;
}

/* The file that should be playing now: a custom track, else the effect's own,
 * looked for next to the shader first (../sounds), then in the usual places. */
static const char *wanted(struct overlay *ov, char *buf)
{
	if (ov->sound_custom[0])
		return ov->sound_custom;
	if (!ov->sound_effect[0])
		return NULL;
	char dir[PATH_MAX], cand[PATH_MAX + 128];
	snprintf(dir, sizeof dir, "%s", ov->shader_path);
	char *slash = strrchr(dir, '/');
	if (slash) {
		*slash = '\0';
		for (size_t e = 0; e < sizeof exts / sizeof *exts; e++) {
			snprintf(cand, sizeof cand, "%s/../sounds/%s.%s", dir, ov->sound_effect, exts[e]);
			if (access(cand, R_OK) == 0 && realpath(cand, buf))
				return buf;
		}
	}
	return sound_resolve(ov->sound_effect, buf);
}

const char *sound_current(struct overlay *ov)
{
	return ov->sound_playing[0] ? ov->sound_playing : NULL;
}

/* rain.frag's storm(): the same hash and value noise, in C. */
static float hash11(float p)
{
	p = p * 0.1031f;
	p -= floorf(p);
	p *= p + 33.33f;
	p *= p + p;
	return p - floorf(p);
}

static float noise1(float x)
{
	float i = floorf(x), f = x - i;
	return hash11(i) + (hash11(i + 1) - hash11(i)) * f * f * (3 - 2 * f);
}

static float smooth(float a, float b, float x)
{
	float t = fminf(fmaxf((x - a) / (b - a), 0), 1);
	return t * t * (3 - 2 * t);
}

/* 0 = silent .. ~1 at the effect's default strength. */
static float loudness(struct overlay *ov)
{
	if (!ov->sound_follow[0])
		return 1.0f;
	float strength = param_get(ov, ov->sound_follow, 1.0f);
	float var = param_get(ov, "uVariation", 0.0f);
	float t = (float)ov->time * param_get(ov, "uSpeed", 1.0f);
	float n = noise1(t / 45) * 0.6f + noise1(t / 14 + 5) * 0.3f + noise1(t / 4 + 9) * 0.1f;
	float k = strength * (1 + var * (0.25f + 1.5f * smooth(0.2f, 0.8f, n) - 1));
	return fminf(sqrtf(fmaxf(k, 0)), 1.5f); /* sqrt: a downpour is louder, not deafening */
}

#ifdef HAVE_MPV

static void drain(struct overlay *ov)
{
	mpv_handle *mpv = ov->mpv;
	for (;;) {
		mpv_event *ev = mpv_wait_event(mpv, 0);
		if (ev->event_id == MPV_EVENT_NONE)
			break;
		if (ev->event_id == MPV_EVENT_END_FILE) {
			mpv_event_end_file *end = ev->data;
			if (end->reason == MPV_END_FILE_REASON_ERROR) {
				fprintf(stderr, "gl-overlay: sound: cannot play %s: %s\n",
				        ov->sound_playing, mpv_error_string(end->error));
				ov->sound_playing[0] = '\0';
			}
		} else if (ev->event_id == MPV_EVENT_LOG_MESSAGE) {
			mpv_event_log_message *msg = ev->data;
			fprintf(stderr, "gl-overlay: sound: %s", msg->text);
		}
	}
}

static bool start_mpv(struct overlay *ov)
{
	mpv_handle *mpv = mpv_create();
	if (!mpv) {
		fprintf(stderr, "gl-overlay: sound: cannot create mpv\n");
		return false;
	}
	/* Only audio, no config, no keys, no terminal: this is a background track. */
	mpv_set_option_string(mpv, "config", "no");
	mpv_set_option_string(mpv, "terminal", "no");
	mpv_set_option_string(mpv, "video", "no");
	mpv_set_option_string(mpv, "input-default-bindings", "no");
	mpv_set_option_string(mpv, "loop-file", "inf");
	mpv_set_option_string(mpv, "idle", "yes");
	mpv_set_option_string(mpv, "audio-client-name", "Hyperion-RAIN");
	mpv_set_option_string(mpv, "volume-max", "100");
	if (mpv_initialize(mpv) < 0) {
		fprintf(stderr, "gl-overlay: sound: cannot initialise mpv\n");
		mpv_terminate_destroy(mpv);
		return false;
	}
	mpv_request_log_messages(mpv, "error");
	ov->mpv = mpv;
	return true;
}

void sound_update(struct overlay *ov, bool force)
{
	if (!ov->sound_on) {
		if (ov->mpv && ov->sound_playing[0]) {
			const char *cmd[] = { "stop", NULL };
			mpv_command_async(ov->mpv, 0, cmd);
			ov->sound_playing[0] = '\0';
		}
		if (ov->mpv)
			drain(ov);
		return;
	}

	double now = now_seconds();
	if (!force && now - ov->sound_last < 0.25)
		return;
	ov->sound_last = now;

	char buf[PATH_MAX];
	const char *path = wanted(ov, buf);
	if (!path) {
		if (ov->mpv && ov->sound_playing[0]) {
			const char *cmd[] = { "stop", NULL };
			mpv_command_async(ov->mpv, 0, cmd);
			ov->sound_playing[0] = '\0';
		}
		return;
	}
	if (!ov->mpv && !start_mpv(ov)) {
		ov->sound_on = false;
		return;
	}
	if (strcmp(path, ov->sound_playing) != 0) {
		snprintf(ov->sound_playing, sizeof ov->sound_playing, "%s", path);
		const char *cmd[] = { "loadfile", ov->sound_playing, NULL };
		mpv_command_async(ov->mpv, 0, cmd);
		fprintf(stderr, "gl-overlay: sound: %s\n", path);
	}

	/* Silent while the overlay is paused or hidden, like the picture. */
	int pause = ov->paused || !ov->visible;
	mpv_set_property_async(ov->mpv, 0, "pause", MPV_FORMAT_FLAG, &pause);
	double vol = 100.0 * fmin(fmax(ov->volume, 0), 1) * fmin(loudness(ov) / 1.2, 1);
	mpv_set_property_async(ov->mpv, 0, "volume", MPV_FORMAT_DOUBLE, &vol);
	drain(ov);
}

void sound_finish(struct overlay *ov)
{
	if (ov->mpv)
		mpv_terminate_destroy(ov->mpv);
	ov->mpv = NULL;
}

bool sound_available(void) { return true; }

#else /* !HAVE_MPV */

void sound_update(struct overlay *ov, bool force) { ov->sound_on = false; }
void sound_finish(struct overlay *ov) {}
bool sound_available(void) { return false; }

#endif
