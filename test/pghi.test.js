"use strict";

const assert = require("assert");
const FFT = require("fft.js");
const { PGHIPitchShifter } = require("../src/pghi.js");

const SAMPLE_RATE = 44100;
const BLOCK = 128;

/** Run `signal` through a fresh shifter in 128-sample blocks. pitchAt(blockIndex) gives the factor. */
function run(signal, pitchAt) {
    const shifter = new PGHIPitchShifter();
    const out = new Float32Array(signal.length);
    const inBlock = new Float32Array(BLOCK);
    const outBlock = new Float32Array(BLOCK);
    for (let b = 0; b + BLOCK <= signal.length; b += BLOCK) {
        inBlock.set(signal.subarray(b, b + BLOCK));
        shifter.process(inBlock, outBlock, pitchAt(b / BLOCK));
        out.set(outBlock, b);
    }
    return out;
}

function tone(freqs, seconds) {
    const x = new Float32Array(Math.round(seconds * SAMPLE_RATE));
    freqs.forEach((f, k) => {
        for (let n = 0; n < x.length; n++) x[n] += Math.sin((2 * Math.PI * f * n) / SAMPLE_RATE) / freqs.length;
    });
    return x;
}

/** Magnitude spectrum of the last `size` samples (Hann windowed). */
function spectrum(x, size = 16384) {
    const fft = new FFT(size);
    const frame = new Float64Array(size);
    const start = x.length - size;
    for (let i = 0; i < size; i++) frame[i] = x[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
    const out = fft.createComplexArray();
    fft.realTransform(out, frame);
    const mags = new Float64Array(size / 2);
    for (let k = 0; k < mags.length; k++) mags[k] = Math.hypot(out[2 * k], out[2 * k + 1]);
    return mags;
}

/** Peak frequency in Hz with parabolic interpolation, and the fraction of energy within +-4 bins of it. */
function dominant(x, size = 16384) {
    const mags = spectrum(x, size);
    let peak = 1;
    for (let k = 1; k < mags.length - 1; k++) if (mags[k] > mags[peak]) peak = k;
    const a = Math.log(mags[peak - 1]);
    const b = Math.log(mags[peak]);
    const c = Math.log(mags[peak + 1]);
    const delta = (0.5 * (a - c)) / (a - 2 * b + c);
    let near = 0;
    let total = 0;
    for (let k = 0; k < mags.length; k++) {
        const e = mags[k] * mags[k];
        total += e;
        if (Math.abs(k - peak) <= 4) near += e;
    }
    return { freq: ((peak + delta) * SAMPLE_RATE) / size, purity: near / total };
}

function rms(x, from = 0) {
    let s = 0;
    for (let i = from; i < x.length; i++) s += x[i] * x[i];
    return Math.sqrt(s / (x.length - from));
}

const semitones = (n) => Math.pow(2, n / 12);
const cents = (a, b) => 1200 * Math.log2(a / b);

// 1. pure tone: pitch accuracy, spectral purity and level, up and down
for (const st of [-12, -5, 0, 2, 7, 12]) {
    const input = tone([440], 4);
    const output = run(input, () => semitones(st));
    const { freq, purity } = dominant(output);
    const expected = 440 * semitones(st);
    const err = cents(freq, expected);
    const level = rms(output, 2 * SAMPLE_RATE) / rms(input, 2 * SAMPLE_RATE);
    console.log(
        `sine ${st >= 0 ? "+" : ""}${st} st: ${freq.toFixed(2)} Hz (expected ${expected.toFixed(2)}, ${err.toFixed(2)} cents), purity ${(purity * 100).toFixed(1)}%, level ${level.toFixed(3)}`,
    );
    assert(Math.abs(err) < 5, `pitch off by ${err} cents at ${st} st`);
    assert(purity > 0.995, `tone smeared at ${st} st (purity ${purity})`);
    assert(level > 0.7 && level < 1.3, `level ${level} at ${st} st`);
}

// 2. chord: every partial must move by the same ratio
{
    const input = tone([220, 277.18, 329.63], 4);
    const output = run(input, () => semitones(3));
    const mags = spectrum(output);
    for (const f of [220, 277.18, 329.63]) {
        const target = Math.round((f * semitones(3) * 16384) / SAMPLE_RATE);
        let best = 0;
        for (let k = target - 3; k <= target + 3; k++) best = Math.max(best, mags[k]);
        const floor = mags.reduce((s, v) => s + v, 0) / mags.length;
        assert(best > 50 * floor, `missing partial at ${f * semitones(3)} Hz`);
    }
    console.log("chord +3 st: all partials present");
}

// 3. pitch changes while playing (as the slider does): finite output, correct final pitch
{
    const input = tone([440], 6);
    const output = run(input, (b) => semitones(((b >> 5) % 9) - 4));
    assert(output.every(Number.isFinite), "non-finite sample after pitch changes");
    const final = run(input, (b) => (b < 400 ? semitones(-7) : semitones(5)));
    const { freq } = dominant(final);
    assert(Math.abs(cents(freq, 440 * semitones(5))) < 10, `settled at ${freq} Hz`);
    console.log("pitch changes mid-stream: stable");
}

// 4. silence in, silence out; impulses and noise stay finite and bounded
{
    const silent = run(new Float32Array(SAMPLE_RATE), () => semitones(5));
    assert(silent.every((v) => v === 0), "silence should stay silent");
    const noise = new Float32Array(2 * SAMPLE_RATE);
    for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 0.5;
    for (let i = 0; i < noise.length; i += 11025) noise[i] = 1;
    const out = run(noise, () => semitones(7));
    assert(out.every(Number.isFinite), "non-finite output on noise");
    assert(Math.max(...out.map(Math.abs)) < 4, "output blew up on noise/impulses");
    console.log("silence / noise / impulses: ok");
}

// 4b. shifting down must not create content above the shifted band (resampler imaging).
// Input is noise low-passed at 16 kHz, like a typical mp3; a -5 st shift puts its edge at ~12 kHz.
{
    const L = 1 << 18;
    const fft = new FFT(L);
    const white = new Float64Array(L).map(() => Math.random() * 2 - 1);
    const sp = fft.createComplexArray();
    fft.realTransform(sp, white);
    for (let k = Math.floor((16000 / SAMPLE_RATE) * L); k <= L / 2; k++) sp[2 * k] = sp[2 * k + 1] = 0;
    fft.completeSpectrum(sp);
    const td = fft.createComplexArray();
    fft.inverseTransform(td, sp);
    const lp = new Float64Array(L);
    fft.fromComplexArray(td, lp);
    const peak = lp.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const input = new Float32Array(4 * SAMPLE_RATE).map((_, n) => (0.5 * lp[n]) / peak);
    for (const st of [-1, -5, -12]) {
        const mags = spectrum(run(input, () => semitones(st)));
        const edge = Math.max(13000, 16000 * semitones(st) + 500);
        let above = 0;
        let total = 0;
        mags.forEach((m, k) => {
            total += m * m;
            if ((k * SAMPLE_RATE) / 16384 >= edge) above += m * m;
        });
        const db = 10 * Math.log10(above / total);
        console.log(`band-limited noise ${st} st: ${db.toFixed(1)} dB above the shifted band`);
        assert(db < -60, `imaging above the shifted band at ${st} st: ${db} dB`);
    }
}

// 5. cost: worst-case time of one block (a frame is processed every 4th block)
{
    const shifter = new PGHIPitchShifter();
    const noise = new Float32Array(BLOCK);
    const out = new Float32Array(BLOCK);
    let worst = 0;
    let total = 0;
    const blocks = 2000;
    for (let b = 0; b < blocks; b++) {
        for (let i = 0; i < BLOCK; i++) noise[i] = Math.random() * 2 - 1;
        const t0 = process.hrtime.bigint();
        shifter.process(noise, out, semitones(5));
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (b > 100) {
            worst = Math.max(worst, ms);
            total += ms;
        }
    }
    const budget = (BLOCK / SAMPLE_RATE) * 1000;
    console.log(
        `cost per channel on noise: mean ${(total / (blocks - 100)).toFixed(3)} ms, worst ${worst.toFixed(3)} ms per block (budget ${budget.toFixed(2)} ms for stereo)`,
    );
}

console.log("all PGHI tests passed");
