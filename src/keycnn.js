/**
 * Key classifier inference: the CNN of Korzeniowski & Widmer, "Genre-agnostic key classification with convolutional
 * neural networks" (ISMIR 2018), weights from madmom (CC BY-NC-SA 4.0, non-commercial). The network is tiny
 * (0.67 M parameters), so plain Float32Array loops are enough and no ML runtime is needed.
 *
 * Input is 60 s at 44.1 kHz mono. Pipeline: Hann STFT (8192 points, 5 frames/s, centred) -> log-frequency filterbank
 * -> log10(x + 1) -> conv/ELU/max-pool blocks -> global average -> softmax over 24 keys.
 *
 * Weight file: u32 LE header length, UTF-8 JSON header, then float16 LE tensors in the order the header lists.
 */
import FFT from "fft.js";

export const SAMPLE_RATE = 44100;
export const WINDOW_SAMPLES = 60 * SAMPLE_RATE;
const FFT_SIZE = 8192;
const HOP = 8820; // SAMPLE_RATE / 5 frames per second

function half(h) {
    const sign = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 31;
    const f = h & 1023;
    if (e === 0) return sign * f * 2 ** -24;
    if (e === 31) return f ? NaN : sign * Infinity;
    return sign * (1 + f / 1024) * 2 ** (e - 15);
}

/** Parses the weight file into { labels, frames, bins, bands, filterbank, layers: [{ in, out, kt, kf, pad, pool, weight, bias }] }. */
export function loadModel(buffer) {
    const headerLength = new DataView(buffer).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)));
    const data = new Uint16Array(buffer.slice(4 + headerLength));
    let offset = 0;
    const take = (count) => {
        const out = new Float32Array(count);
        for (let i = 0; i < count; i++) out[i] = half(data[offset + i]);
        offset += count;
        return out;
    };
    const filterbank = take(header.bins * header.bands);
    const layers = header.layers.map((l) => ({
        ...l,
        weight: take(l.out * l.in * l.kt * l.kf),
        bias: take(l.out),
    }));
    return { ...header, filterbank, layers };
}

/** Cross-correlation, stride 1, zero padding `pad` on every side. x is (in, h, w), weight (out, in, kt, kf). */
export function conv2d(x, inC, h, w, weight, bias, outC, kt, kf, pad) {
    if (kt === 3 && kf === 3 && outC % 4 === 0) return conv3x3(x, inC, h, w, weight, bias, outC, pad);
    return conv2dGeneric(x, inC, h, w, weight, bias, outC, kt, kf, pad);
}

/**
 * Same result as conv2dGeneric for 3x3 kernels, about 4x faster (these layers are ~95% of the network's time).
 * Pads the input once so the inner loop has no bounds checks, unrolls the nine taps, and computes four output
 * channels per pass so each input value is loaded once for four accumulators.
 */
function conv3x3(x, inC, h, w, weight, bias, outC, pad) {
    const ph = h + 2 * pad;
    const pw = w + 2 * pad;
    const oh = ph - 2;
    const ow = pw - 2;
    const padded = new Float32Array(inC * ph * pw);
    for (let c = 0; c < inC; c++) {
        for (let y = 0; y < h; y++) {
            padded.set(x.subarray(c * h * w + y * w, c * h * w + (y + 1) * w), c * ph * pw + (y + pad) * pw + pad);
        }
    }

    const plane = oh * ow;
    const out = new Float32Array(outC * plane);
    for (let o = 0; o < outC; o += 4) {
        const p0 = o * plane;
        const p1 = p0 + plane;
        const p2 = p1 + plane;
        const p3 = p2 + plane;
        out.fill(bias[o], p0, p1);
        out.fill(bias[o + 1], p1, p2);
        out.fill(bias[o + 2], p2, p3);
        out.fill(bias[o + 3], p3, p3 + plane);

        for (let c = 0; c < inC; c++) {
            const k0 = (o * inC + c) * 9;
            const k1 = k0 + inC * 9;
            const k2 = k1 + inC * 9;
            const k3 = k2 + inC * 9;
            const a0 = weight[k0], a1 = weight[k0 + 1], a2 = weight[k0 + 2], a3 = weight[k0 + 3], a4 = weight[k0 + 4];
            const a5 = weight[k0 + 5], a6 = weight[k0 + 6], a7 = weight[k0 + 7], a8 = weight[k0 + 8];
            const b0 = weight[k1], b1 = weight[k1 + 1], b2 = weight[k1 + 2], b3 = weight[k1 + 3], b4 = weight[k1 + 4];
            const b5 = weight[k1 + 5], b6 = weight[k1 + 6], b7 = weight[k1 + 7], b8 = weight[k1 + 8];
            const c0 = weight[k2], c1 = weight[k2 + 1], c2 = weight[k2 + 2], c3 = weight[k2 + 3], c4 = weight[k2 + 4];
            const c5 = weight[k2 + 5], c6 = weight[k2 + 6], c7 = weight[k2 + 7], c8 = weight[k2 + 8];
            const d0 = weight[k3], d1 = weight[k3 + 1], d2 = weight[k3 + 2], d3 = weight[k3 + 3], d4 = weight[k3 + 4];
            const d5 = weight[k3 + 5], d6 = weight[k3 + 6], d7 = weight[k3 + 7], d8 = weight[k3 + 8];

            const base = c * ph * pw;
            for (let y = 0; y < oh; y++) {
                let r0 = base + y * pw;
                let r1 = r0 + pw;
                let r2 = r1 + pw;
                let i = y * ow;
                for (let xo = 0; xo < ow; xo++, r0++, r1++, r2++, i++) {
                    const v0 = padded[r0], v1 = padded[r0 + 1], v2 = padded[r0 + 2];
                    const v3 = padded[r1], v4 = padded[r1 + 1], v5 = padded[r1 + 2];
                    const v6 = padded[r2], v7 = padded[r2 + 1], v8 = padded[r2 + 2];
                    out[p0 + i] += a0 * v0 + a1 * v1 + a2 * v2 + a3 * v3 + a4 * v4 + a5 * v5 + a6 * v6 + a7 * v7 + a8 * v8;
                    out[p1 + i] += b0 * v0 + b1 * v1 + b2 * v2 + b3 * v3 + b4 * v4 + b5 * v5 + b6 * v6 + b7 * v7 + b8 * v8;
                    out[p2 + i] += c0 * v0 + c1 * v1 + c2 * v2 + c3 * v3 + c4 * v4 + c5 * v5 + c6 * v6 + c7 * v7 + c8 * v8;
                    out[p3 + i] += d0 * v0 + d1 * v1 + d2 * v2 + d3 * v3 + d4 * v4 + d5 * v5 + d6 * v6 + d7 * v7 + d8 * v8;
                }
            }
        }
    }
    return { data: out, h: oh, w: ow };
}

/** Reference implementation: any kernel size, one tap at a time. Exported so tests can check the fast path. */
export function conv2dGeneric(x, inC, h, w, weight, bias, outC, kt, kf, pad) {
    const oh = h + 2 * pad - kt + 1;
    const ow = w + 2 * pad - kf + 1;
    const out = new Float32Array(outC * oh * ow);
    for (let o = 0; o < outC; o++) {
        const plane = out.subarray(o * oh * ow, (o + 1) * oh * ow);
        plane.fill(bias[o]);
        for (let c = 0; c < inC; c++) {
            for (let dt = 0; dt < kt; dt++) {
                for (let df = 0; df < kf; df++) {
                    const wv = weight[((o * inC + c) * kt + dt) * kf + df];
                    if (wv === 0) continue;
                    // output (y, xo) reads input (y + dt - pad, xo + df - pad); clip to the valid range
                    const xo0 = Math.max(0, pad - df);
                    const xo1 = Math.min(ow, w + pad - df);
                    for (let y = 0; y < oh; y++) {
                        const iy = y + dt - pad;
                        if (iy < 0 || iy >= h) continue;
                        const src = c * h * w + iy * w + (df - pad);
                        const dst = y * ow;
                        for (let xo = xo0; xo < xo1; xo++) plane[dst + xo] += wv * x[src + xo];
                    }
                }
            }
        }
    }
    return { data: out, h: oh, w: ow };
}

export function elu(x) {
    for (let i = 0; i < x.length; i++) if (x[i] < 0) x[i] = Math.expm1(x[i]);
}

/** 2x2 max pool, stride 2, odd trailing row/column dropped. */
export function maxPool2(x, c, h, w) {
    const oh = h >> 1;
    const ow = w >> 1;
    const out = new Float32Array(c * oh * ow);
    for (let k = 0; k < c; k++) {
        for (let y = 0; y < oh; y++) {
            for (let xo = 0; xo < ow; xo++) {
                const i = k * h * w + 2 * y * w + 2 * xo;
                out[k * oh * ow + y * ow + xo] = Math.max(x[i], x[i + 1], x[i + w], x[i + w + 1]);
            }
        }
    }
    return { data: out, h: oh, w: ow };
}

// Built once per worker: the FFT plan, window and scratch buffers don't depend on the song.
const fft = new FFT(FFT_SIZE);
const window = new Float32Array(FFT_SIZE).map(
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)),
);
const frame = new Float32Array(FFT_SIZE);
const fftOut = fft.createComplexArray();

/** Centred symmetric-Hann STFT magnitudes, first `bins` bins, `frames` rows (zero padded past the ends). */
function spectrogram(samples, frames, bins) {
    const count = Math.max(1, Math.ceil(samples.length / HOP));
    const out = new Float32Array(frames * bins);
    for (let f = 0; f < Math.min(frames, count); f++) {
        const start = f * HOP - FFT_SIZE / 2;
        for (let i = 0; i < FFT_SIZE; i++) {
            const s = start + i;
            frame[i] = s >= 0 && s < samples.length ? samples[s] * window[i] : 0;
        }
        fft.realTransform(fftOut, frame);
        for (let k = 0; k < bins; k++)
            out[f * bins + k] = Math.sqrt(fftOut[2 * k] ** 2 + fftOut[2 * k + 1] ** 2);
    }
    // A short track fills the model's input by cycling through its frames.
    for (let f = count; f < frames; f++)
        out.copyWithin(f * bins, (f % count) * bins, (f % count) * bins + bins);
    return out;
}

// The filterbank is triangular filters, so each FFT bin touches only a couple of bands; skip the zeros.
const bandRanges = new WeakMap();
function filterRanges(model) {
    let ranges = bandRanges.get(model);
    if (!ranges) {
        const { bins, bands, filterbank } = model;
        ranges = new Int32Array(bins * 2); // [first band, one past the last band] per bin
        for (let k = 0; k < bins; k++) {
            let first = bands;
            let end = 0;
            for (let b = 0; b < bands; b++) {
                if (filterbank[k * bands + b] !== 0) {
                    first = Math.min(first, b);
                    end = b + 1;
                }
            }
            ranges[2 * k] = first < end ? first : 0;
            ranges[2 * k + 1] = end;
        }
        bandRanges.set(model, ranges);
    }
    return ranges;
}

/** Softmax probabilities over `model.labels` for up to 60 s of 44.1 kHz mono audio. */
export function predict(model, samples) {
    const { frames, bins, bands } = model;
    const spec = spectrogram(samples, frames, bins);

    // (frames, bins) x (bins, bands), then log10(x + 1)
    const ranges = filterRanges(model);
    let x = new Float32Array(frames * bands);
    for (let t = 0; t < frames; t++) {
        for (let k = 0; k < bins; k++) {
            const m = spec[t * bins + k];
            if (m === 0) continue;
            const row = k * bands;
            for (let b = ranges[2 * k]; b < ranges[2 * k + 1]; b++)
                x[t * bands + b] += m * model.filterbank[row + b];
        }
    }
    for (let i = 0; i < x.length; i++) x[i] = Math.log10(x[i] + 1);

    let c = 1;
    let h = frames;
    let w = bands;
    for (const layer of model.layers) {
        const y = conv2d(
            x,
            c,
            h,
            w,
            layer.weight,
            layer.bias,
            layer.out,
            layer.kt,
            layer.kf,
            layer.pad,
        );
        elu(y.data);
        ({ data: x, h, w } = layer.pool ? maxPool2(y.data, layer.out, y.h, y.w) : y);
        c = layer.out;
    }

    const logits = new Float32Array(c);
    for (let k = 0; k < c; k++) {
        let sum = 0;
        for (let i = 0; i < h * w; i++) sum += x[k * h * w + i];
        logits[k] = sum / (h * w);
    }
    const max = Math.max(...logits);
    let total = 0;
    for (let k = 0; k < c; k++) total += logits[k] = Math.exp(logits[k] - max);
    return logits.map((v) => v / total);
}
