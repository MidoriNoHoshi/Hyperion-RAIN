/*
 * gl-overlay-still — render one frame of a shader headlessly, for previews
 * and shader development without touching the live desktop.
 *
 *   gl-overlay-still -s rain -t 42 -p uDream=0 -o out.pam
 *   magick bg.png out.pam -composite preview.png
 *
 * Output is PAM (RGB_ALPHA, straight alpha), top row first.
 */
#include <getopt.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "overlay.h"

int main(int argc, char **argv)
{
	struct overlay ov = { .opacity = 1.0f, .visible = true };
	const char *shader = "rain", *outpath = "still.pam";
	int w = 1920, h = 1200;
	double t = 10.0;
	int bench = 0;

	int c;
	while ((c = getopt(argc, argv, "s:o:t:w:h:p:n:")) != -1) {
		switch (c) {
		case 's': shader = optarg; break;
		case 'o': outpath = optarg; break;
		case 't': t = strtod(optarg, NULL); break;
		case 'w': w = atoi(optarg); break;
		case 'h': h = atoi(optarg); break;
		case 'n': bench = atoi(optarg); break;
		case 'p': {
			char *eq = strchr(optarg, '=');
			if (!eq)
				return 1;
			*eq = '\0';
			param_set(&ov, optarg, strtof(eq + 1, NULL));
			break;
		}
		default:
			fprintf(stderr, "usage: gl-overlay-still [-s effect|shader.frag] [-o out.pam] "
			                "[-t seconds] [-w W] [-h H] [-n bench_frames] [-p name=value]...\n");
			return 1;
		}
	}

	char path[PATH_MAX];
	if (!shader_resolve(shader, path)) {
		fprintf(stderr, "gl-overlay-still: %s: no such effect or shader file\n", shader);
		return 1;
	}
	if (!gl_init(&ov, true) || !shader_load(&ov, path))
		return 1;

	GLuint fbo, rb;
	glGenFramebuffers(1, &fbo);
	glBindFramebuffer(GL_FRAMEBUFFER, fbo);
	glGenRenderbuffers(1, &rb);
	glBindRenderbuffer(GL_RENDERBUFFER, rb);
	glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA8, w, h);
	glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, rb);

	ov.time = t;
	draw_frame(&ov, w, h, 1.0 / 60.0);

	if (bench > 0) { /* -n N: time N frames, GPU included */
		glFinish();
		double t0 = now_seconds();
		for (int i = 0; i < bench; i++) {
			ov.time += 1.0 / 60.0;
			draw_frame(&ov, w, h, 1.0 / 60.0);
		}
		glFinish();
		printf("%.2f ms/frame at %dx%d\n", (now_seconds() - t0) * 1000.0 / bench, w, h);
	}

	unsigned char *px = malloc((size_t)w * h * 4);
	glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, px);

	FILE *f = fopen(outpath, "wb");
	if (!f) {
		perror(outpath);
		return 1;
	}
	fprintf(f, "P7\nWIDTH %d\nHEIGHT %d\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n", w, h);
	for (int y = h - 1; y >= 0; y--) {
		unsigned char *row = px + (size_t)y * w * 4;
		for (int x = 0; x < w; x++) {
			unsigned char *p = row + x * 4;
			/* GL gave us premultiplied; PAM wants straight alpha. */
			if (p[3]) {
				for (int i = 0; i < 3; i++) {
					int v = p[i] * 255 / p[3];
					p[i] = v > 255 ? 255 : v;
				}
			}
		}
		fwrite(row, 4, w, f);
	}
	fclose(f);
	free(px);

	glDeleteRenderbuffers(1, &rb);
	glDeleteFramebuffers(1, &fbo);
	gl_finish(&ov);
	return 0;
}
