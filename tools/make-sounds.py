#!/usr/bin/env python3
"""Synthesise the default soundtracks: sounds/rain.ogg and sounds/wind.ogg.

Everything is generated from noise, so the files carry no third-party licence.
Each is a seamless loop (the tail is crossfaded into the head). Needs numpy,
scipy and ffmpeg (libopus).

    python3 tools/make-sounds.py            # writes sounds/*.ogg
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy import signal

SR = 48000
LOOP = 60.0          # seconds
XFADE = 4.0          # seconds crossfaded at the loop point
OUT = Path(__file__).resolve().parent.parent / "sounds"
rng = np.random.default_rng(20261004)


def butter(x, kind, freq, order=2):
    sos = signal.butter(order, freq, kind, fs=SR, output="sos")
    return signal.sosfilt(sos, x, axis=0)


def pink(n, ch=2):
    """Pink-ish noise: white noise shaped by -3 dB/octave in the frequency domain."""
    spec = np.fft.rfft(rng.standard_normal((n, ch)), axis=0)
    f = np.fft.rfftfreq(n, 1 / SR)
    f[0] = f[1]
    spec /= np.sqrt(f)[:, None]
    x = np.fft.irfft(spec, n, axis=0)
    return x / np.std(x)


def slow(n, rate, depth, ch=1):
    """A slow random envelope around 1 (rate in Hz)."""
    k = max(int(n / SR * rate) + 3, 4)
    pts = rng.standard_normal((k, ch))
    x = signal.resample(pts, n, axis=0)
    x /= np.max(np.abs(x)) + 1e-9
    return 1 + depth * x


def impacts(n, rate, f_lo, f_hi, dec_lo, dec_hi, amp_pow, width):
    """Short decaying pings and clicks at Poisson times: single drops landing."""
    out = np.zeros((n, 2))
    count = rng.poisson(rate * n / SR)
    times = rng.integers(0, n, count)
    for t0 in times:
        f = np.exp(rng.uniform(np.log(f_lo), np.log(f_hi)))
        dec = rng.uniform(dec_lo, dec_hi)
        ln = min(int(dec * 6 * SR), n - t0)
        if ln < 16:
            continue
        tt = np.arange(ln) / SR
        env = np.exp(-tt / dec)
        # a drop on water / glass rises slightly in pitch as it rings out
        ph = 2 * np.pi * np.cumsum(f * (1 + 0.25 * (1 - env))) / SR
        s = np.sin(ph) * env
        s[: min(48, ln)] += rng.standard_normal(min(48, ln)) * 0.6 * np.linspace(1, 0, min(48, ln))
        a = rng.pareto(amp_pow) + 0.2
        pan = min(max(0.5 + (rng.random() - 0.5) * width, 0.0), 1.0)
        out[t0:t0 + ln, 0] += s * a * np.sqrt(1 - pan)
        out[t0:t0 + ln, 1] += s * a * np.sqrt(pan)
    return out


def loopify(x):
    """Crossfade the extra tail over the head so the file loops without a seam."""
    n, xf = int(LOOP * SR), int(XFADE * SR)
    head, tail = x[:xf], x[n:n + xf]
    w = np.linspace(0, np.pi / 2, xf)[:, None]
    y = x[:n].copy()
    y[:xf] = head * np.sin(w) + tail * np.cos(w)    # equal power: the layers are uncorrelated noise
    return y


def normalise(x, rms_db):
    x = x - np.mean(x, axis=0)
    x *= 10 ** (rms_db / 20) / np.sqrt(np.mean(x ** 2))
    peak = np.max(np.abs(x))
    if peak > 0.89:                                    # soft-limit the odd loud drop
        x = np.tanh(x / 0.89) * 0.89
    return x


def rain():
    n = int((LOOP + XFADE) * SR)
    gust = slow(n, 0.08, 0.25)
    # the wash: countless far drops on roofs and leaves
    bed = butter(butter(pink(n), "highpass", 180), "lowpass", 7000) * gust * 0.55
    # a softer, darker layer: rain on the street, gutters
    low = butter(pink(n), "lowpass", 600, 3) * slow(n, 0.05, 0.3) * 0.35
    # near patter: dense small drops
    pat = impacts(n, 260, 1800, 7000, 0.0015, 0.006, 3.0, 1.6) * 0.07
    pat = butter(pat, "highpass", 900) * gust
    # drops tapping the window: sparser, closer, a little lower
    tap = impacts(n, 16, 700, 2600, 0.004, 0.014, 2.5, 1.2) * 0.12
    # a drip from the eaves now and then: a round "plink"
    drip = impacts(n, 0.6, 500, 1100, 0.02, 0.05, 4.0, 0.8) * 0.12
    return normalise(loopify(bed + low + pat + tap + drip), -22)


def wind():
    n = int((LOOP + XFADE) * SR)
    gust = np.clip(slow(n, 0.12, 0.7), 0.15, None)
    x = pink(n)
    # a howl: a resonant band that wanders with the gusts
    out = np.zeros_like(x)
    blk = SR // 20
    zi = None
    centre = 220 + 380 * (gust[:, 0] - gust.min()) / (np.ptp(gust) + 1e-9)
    for i in range(0, n, blk):
        f = centre[i]
        sos = signal.butter(2, [f * 0.7, f * 1.4], "bandpass", fs=SR, output="sos")
        if zi is None:
            zi = np.zeros((sos.shape[0], 2, 2))
        out[i:i + blk], zi = signal.sosfilt(sos, x[i:i + blk], axis=0, zi=zi)
    body = butter(x, "lowpass", 900) * 0.5
    hiss = butter(x, "highpass", 3000) * 0.04
    return normalise(loopify((out * 1.4 + body + hiss) * gust), -24)


def write(name, x):
    OUT.mkdir(exist_ok=True)
    path = OUT / f"{name}.ogg"
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "2",
                    "-i", "-", "-c:a", "libopus", "-b:a", "96k",
                    "-metadata", "title=Hyperion-RAIN " + name,
                    "-metadata", "comment=synthesised by tools/make-sounds.py",
                    str(path)], input=pcm, check=True)
    print(path, f"{path.stat().st_size // 1024} KiB")


if __name__ == "__main__":
    which = sys.argv[1:] or ["rain", "wind"]
    for name in which:
        write(name, {"rain": rain, "wind": wind}[name]())
