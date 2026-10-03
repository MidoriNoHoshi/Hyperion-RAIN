/*
 * EGL/GLES3 side: context setup, ShaderToy-compatible shader wrapping,
 * noise channel textures and per-output rendering.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "overlay.h"
#include <EGL/eglext.h>

double now_seconds(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec + ts.tv_nsec * 1e-9;
}

/* --------------------------------------------------------------- shaders */

static const char *vert_src =
	"#version 300 es\n"
	"void main() {\n"
	"    // Fullscreen triangle, no vertex buffer needed.\n"
	"    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\n"
	"    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);\n"
	"}\n";

/* Prepended to every user shader: ShaderToy uniforms + overlay extras. */
static const char *frag_header =
	"#version 300 es\n"
	"precision highp float;\n"
	"precision highp int;\n"
	"uniform vec3  iResolution;\n"
	"uniform float iTime;\n"
	"uniform float iTimeDelta;\n"
	"uniform int   iFrame;\n"
	"uniform vec4  iMouse;\n"
	"uniform vec4  iDate;\n"
	"uniform vec3  iChannelResolution[4];\n"
	"uniform sampler2D iChannel0;\n"
	"uniform sampler2D iChannel1;\n"
	"uniform sampler2D iChannel2;\n"
	"uniform sampler2D iChannel3;\n"
	"uniform float uOpacity;\n"
	"out vec4 overlay_FragColor;\n";

/*
 * mainImage() returns straight (non-premultiplied) RGBA where alpha means
 * "how much of the overlay covers the desktop". Wayland expects
 * premultiplied alpha, so we convert here.
 */
static const char *frag_footer =
	"\nvoid main() {\n"
	"    vec4 c = vec4(0.0);\n"
	"    mainImage(c, gl_FragCoord.xy);\n"
	"    c = clamp(c, 0.0, 1.0);\n"
	"    float a = c.a * uOpacity;\n"
	"    overlay_FragColor = vec4(c.rgb * a, a);\n"
	"}\n";

static GLuint compile(GLenum type, const char *const *srcs, int n)
{
	GLuint s = glCreateShader(type);
	glShaderSource(s, n, srcs, NULL);
	glCompileShader(s);
	GLint ok;
	glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
	if (!ok) {
		char log[4096];
		glGetShaderInfoLog(s, sizeof log, NULL, log);
		fprintf(stderr, "gl-overlay: shader compile error:\n%s", log);
		glDeleteShader(s);
		return 0;
	}
	return s;
}

static char *read_file(const char *path)
{
	FILE *f = fopen(path, "rb");
	if (!f)
		return NULL;
	fseek(f, 0, SEEK_END);
	long len = ftell(f);
	fseek(f, 0, SEEK_SET);
	char *buf = malloc(len + 1);
	if (fread(buf, 1, len, f) != (size_t)len) {
		free(buf);
		fclose(f);
		return NULL;
	}
	buf[len] = '\0';
	fclose(f);
	return buf;
}

static struct param *param_find(struct overlay *ov, const char *name)
{
	for (int i = 0; i < ov->n_params; i++)
		if (strcmp(ov->params[i].name, name) == 0)
			return &ov->params[i];
	return NULL;
}

static struct param *param_add(struct overlay *ov, const char *name)
{
	struct param *p = param_find(ov, name);
	if (p || ov->n_params == MAX_PARAMS)
		return p;
	p = &ov->params[ov->n_params++];
	memset(p, 0, sizeof *p);
	snprintf(p->name, sizeof p->name, "%s", name);
	return p;
}

/* Runtime (IPC) override. Sticks across shader reloads. */
void param_set(struct overlay *ov, const char *name, float value)
{
	struct param *p = param_add(ov, name);
	if (!p)
		return;
	p->value = value;
	p->overridden = true;
}

/*
 * Prepare the user source:
 *  - drop any `#version` line (we supply our own)
 *  - pick up `#pragma param <name> <default>` declarations; GLSL compilers
 *    ignore unknown pragmas, so the file stays valid ShaderToy-ish GLSL.
 */
static void preprocess(struct overlay *ov, char *src)
{
	for (char *line = src; line && *line;) {
		char *next = strchr(line, '\n');
		char *s = line;
		while (*s == ' ' || *s == '\t')
			s++;

		if (strncmp(s, "#version", 8) == 0) {
			for (char *c = line; c < (next ? next : line + strlen(line)); c++)
				*c = ' ';
		} else if (strncmp(s, "#pragma param", 13) == 0) {
			char name[64];
			float def;
			if (sscanf(s + 13, " %63s %f", name, &def) == 2) {
				struct param *p = param_add(ov, name);
				if (p && !p->overridden)
					p->value = def;
			}
		}
		line = next ? next + 1 : NULL;
	}
}

bool shader_load(struct overlay *ov, const char *path)
{
	char *src = read_file(path);
	if (!src) {
		fprintf(stderr, "gl-overlay: cannot read shader '%s'\n", path);
		return false;
	}
	preprocess(ov, src);

	const char *frag_srcs[] = { frag_header, "#line 1\n", src, frag_footer };
	GLuint vs = compile(GL_VERTEX_SHADER, &vert_src, 1);
	GLuint fs = compile(GL_FRAGMENT_SHADER, frag_srcs, 4);
	free(src);
	if (!vs || !fs) {
		if (vs) glDeleteShader(vs);
		if (fs) glDeleteShader(fs);
		return false; /* keep the previous program running */
	}

	GLuint prog = glCreateProgram();
	glAttachShader(prog, vs);
	glAttachShader(prog, fs);
	glLinkProgram(prog);
	glDeleteShader(vs);
	glDeleteShader(fs);

	GLint ok;
	glGetProgramiv(prog, GL_LINK_STATUS, &ok);
	if (!ok) {
		char log[4096];
		glGetProgramInfoLog(prog, sizeof log, NULL, log);
		fprintf(stderr, "gl-overlay: link error:\n%s", log);
		glDeleteProgram(prog);
		return false;
	}

	if (ov->program)
		glDeleteProgram(ov->program);
	ov->program = prog;
	if (path != ov->shader_path)
		snprintf(ov->shader_path, sizeof ov->shader_path, "%s", path);
	ov->frame = 0;
	fprintf(stderr, "gl-overlay: loaded %s\n", path);
	return true;
}

/* -------------------------------------------------------------- channels */

/* ShaderToy-style RGBA noise, tiling, mipmapped. */
static GLuint make_noise(int size, uint32_t seed)
{
	unsigned char *px = malloc(size * size * 4);
	for (int i = 0; i < size * size * 4; i++) {
		seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
		px[i] = seed & 0xff;
	}
	GLuint tex;
	glGenTextures(1, &tex);
	glBindTexture(GL_TEXTURE_2D, tex);
	glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, size, size, 0, GL_RGBA,
	             GL_UNSIGNED_BYTE, px);
	glGenerateMipmap(GL_TEXTURE_2D);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_LINEAR);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);
	free(px);
	return tex;
}

/* ------------------------------------------------------------------- EGL */

/* headless: no Wayland, render into an FBO (used by gl-overlay-still). */
bool gl_init(struct overlay *ov, bool headless)
{
	ov->egl_display = headless
		? eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL)
		: eglGetPlatformDisplay(EGL_PLATFORM_WAYLAND_KHR, ov->display, NULL);
	if (ov->egl_display == EGL_NO_DISPLAY ||
	    !eglInitialize(ov->egl_display, NULL, NULL)) {
		fprintf(stderr, "gl-overlay: EGL init failed\n");
		return false;
	}
	eglBindAPI(EGL_OPENGL_ES_API);

	const EGLint cfg_attr[] = {
		EGL_SURFACE_TYPE, headless ? 0 : EGL_WINDOW_BIT,
		EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
		EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8,
		EGL_ALPHA_SIZE, 8, /* a translucent overlay needs a real alpha channel */
		EGL_NONE,
	};
	EGLint n = 0;
	if (!eglChooseConfig(ov->egl_display, cfg_attr, &ov->egl_config, 1, &n) || !n) {
		fprintf(stderr, "gl-overlay: no RGBA8 GLES3 EGL config\n");
		return false;
	}

	const EGLint ctx_attr[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_NONE };
	ov->egl_context = eglCreateContext(ov->egl_display, ov->egl_config,
	                                   EGL_NO_CONTEXT, ctx_attr);
	if (ov->egl_context == EGL_NO_CONTEXT) {
		fprintf(stderr, "gl-overlay: cannot create GLES3 context\n");
		return false;
	}
	/* Surfaceless current so we can compile shaders before any output exists. */
	eglMakeCurrent(ov->egl_display, EGL_NO_SURFACE, EGL_NO_SURFACE, ov->egl_context);

	glGenVertexArrays(1, &ov->vao);
	for (int i = 0; i < 4; i++) {
		ov->channels[i] = make_noise(256, 0x9e3779b9u * (i + 1));
		ov->channel_res[i][0] = ov->channel_res[i][1] = 256;
	}
	return true;
}

void gl_finish(struct overlay *ov)
{
	if (ov->egl_display == EGL_NO_DISPLAY || !ov->egl_display)
		return;
	if (ov->egl_context) {
		eglMakeCurrent(ov->egl_display, EGL_NO_SURFACE, EGL_NO_SURFACE, ov->egl_context);
		if (ov->program)
			glDeleteProgram(ov->program);
		glDeleteTextures(4, ov->channels);
		glDeleteVertexArrays(1, &ov->vao);
		eglMakeCurrent(ov->egl_display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
		eglDestroyContext(ov->egl_display, ov->egl_context);
	}
	eglTerminate(ov->egl_display);
}

/* ---------------------------------------------------------------- render */

void output_render(struct overlay *ov, struct output *out)
{
	if (!out->configured || out->egl_surface == EGL_NO_SURFACE)
		return;
	/* Paused/hidden and nothing changed: stop the frame loop -> ~0% GPU. */
	if ((ov->paused || !ov->visible) && !out->dirty)
		return;
	out->dirty = false;

	double now = now_seconds();
	double dt = ov->last_frame > 0 ? now - ov->last_frame : 0;
	if (!ov->paused && dt > 0)
		ov->time += dt;
	ov->last_frame = now;
	out->last_render = now;

	eglMakeCurrent(ov->egl_display, out->egl_surface, out->egl_surface, ov->egl_context);
	draw_frame(ov, out->width * out->scale, out->height * out->scale, dt);

	/* Request the next frame *before* swapping (swap commits the surface). */
	if (!ov->paused && ov->visible)
		output_request_frame(out);
	eglSwapBuffers(ov->egl_display, out->egl_surface);
}

/* Draw one frame of the active shader into the current framebuffer. */
void draw_frame(struct overlay *ov, int w, int h, double dt)
{
	glViewport(0, 0, w, h);
	glClearColor(0, 0, 0, 0);
	glClear(GL_COLOR_BUFFER_BIT);

	if (ov->visible && ov->program) {
		GLuint p = ov->program;
		glUseProgram(p);

		glUniform3f(glGetUniformLocation(p, "iResolution"), w, h, 1.0f);
		glUniform1f(glGetUniformLocation(p, "iTime"), (float)ov->time);
		glUniform1f(glGetUniformLocation(p, "iTimeDelta"), (float)dt);
		glUniform1i(glGetUniformLocation(p, "iFrame"), ov->frame);
		/* We take no input, so there is no pointer; scripts can drive it via IPC. */
		struct param *mx = param_find(ov, "iMouse.x"), *my = param_find(ov, "iMouse.y");
		glUniform4f(glGetUniformLocation(p, "iMouse"),
		            mx ? mx->value : 0, my ? my->value : 0, 0, 0);
		glUniform1f(glGetUniformLocation(p, "uOpacity"), ov->opacity);

		time_t t = time(NULL);
		struct tm tm;
		localtime_r(&t, &tm);
		glUniform4f(glGetUniformLocation(p, "iDate"), tm.tm_year + 1900, tm.tm_mon,
		            tm.tm_mday, tm.tm_hour * 3600 + tm.tm_min * 60 + tm.tm_sec);

		float cres[12];
		for (int i = 0; i < 4; i++) {
			char name[16];
			snprintf(name, sizeof name, "iChannel%d", i);
			glActiveTexture(GL_TEXTURE0 + i);
			glBindTexture(GL_TEXTURE_2D, ov->channels[i]);
			glUniform1i(glGetUniformLocation(p, name), i);
			cres[i * 3 + 0] = ov->channel_res[i][0];
			cres[i * 3 + 1] = ov->channel_res[i][1];
			cres[i * 3 + 2] = 1;
		}
		glUniform3fv(glGetUniformLocation(p, "iChannelResolution"), 4, cres);

		for (int i = 0; i < ov->n_params; i++) {
			GLint loc = glGetUniformLocation(p, ov->params[i].name);
			if (loc >= 0)
				glUniform1f(loc, ov->params[i].value);
		}

		glBindVertexArray(ov->vao);
		glDrawArrays(GL_TRIANGLES, 0, 3);
		ov->frame++;
	}
}
