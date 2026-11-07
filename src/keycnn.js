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

/** Centred symmetric-Hann STFT magnitudes, first `bins` bins, `frames` rows (zero padded past the ends). */
function spectrogram(samples, frames, bins) {
    const fft = new FFT(FFT_SIZE);
    const window = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++)
        window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
    const frame = new Float32Array(FFT_SIZE);
    const spec = fft.createComplexArray();
    const count = Math.max(1, Math.ceil(samples.length / HOP));
    const out = new Float32Array(frames * bins);
    for (let f = 0; f < Math.min(frames, count); f++) {
        const start = f * HOP - FFT_SIZE / 2;
        for (let i = 0; i < FFT_SIZE; i++) {
            const s = start + i;
            frame[i] = s >= 0 && s < samples.length ? samples[s] * window[i] : 0;
        }
        fft.realTransform(spec, frame);
        for (let k = 0; k < bins; k++) out[f * bins + k] = Math.hypot(spec[2 * k], spec[2 * k + 1]);
    }
    // A short track fills the model's input by cycling through its frames.
    for (let f = count; f < frames; f++)
        out.copyWithin(f * bins, (f % count) * bins, (f % count) * bins + bins);
    return out;
}

/** Softmax probabilities over `model.labels` for up to 60 s of 44.1 kHz mono audio. */
export function predict(model, samples) {
    const { frames, bins, bands } = model;
    const spec = spectrogram(samples, frames, bins);

    // (frames, bins) x (bins, bands), then log10(x + 1)
    let x = new Float32Array(frames * bands);
    for (let t = 0; t < frames; t++) {
        for (let k = 0; k < bins; k++) {
            const m = spec[t * bins + k];
            if (m === 0) continue;
            const row = k * bands;
            for (let b = 0; b < bands; b++) x[t * bands + b] += m * model.filterbank[row + b];
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
