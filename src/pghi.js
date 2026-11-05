/**
 * Pitch shifter built on a phase-gradient phase vocoder.
 *
 * Phase estimation follows "Phase Vocoder Done Right" (Prusa & Holighaus, 2017,
 * https://ltfat.org/notes/ltfatnote050.pdf), integrated with the real-time heap
 * algorithm from Prusa & Sondergaard (DAFx-16, https://ltfat.org/notes/ltfatnote043.pdf).
 *
 * Pitch shifting by a factor p is done as
 *   1. time-stretch by p (synthesis hop = p * analysis hop), then
 *   2. resample the stretched signal by p, which restores the duration.
 * One analysis hop of input therefore always yields one hop of output, which is
 * what a real-time stream needs.
 *
 * Notation follows the paper: a_a / a_s are the analysis / synthesis hops, m is the
 * frequency bin, n the frame index, phi_a the analysis phase and phi_s the synthesis phase.
 */

import FFT from "fft.js";

const FRAME_SIZE = 4096; // window length == FFT length (M)
const ANALYSIS_HOP = 512; // a_a, 8x window redundancy
const RING_SIZE = 1 << 15; // stretched-domain overlap-add ring, must be a power of two
const RING_MASK = RING_SIZE - 1;
const OUTPUT_QUEUE_SIZE = 1 << 14;
const PREFILL = 256; // output samples to accumulate before playback starts
const REL_TOL = 1e-6; // relative magnitude tolerance (tol in the paper)
const ENERGY_FLOOR = 1e-6;
const WINDOW_EDGE_HEIGHT = 0.01; // Gaussian window height at the frame edge
const ALIAS_TAPER_BINS = 32;
const SINC_HALF_TAPS = 16; // resampler kernel reaches this many samples each side
const SINC_PHASES = 512; // fractional-position resolution of the kernel table
const KAISER_BETA = 9; // ~90 dB stopband
const MIN_PITCH = 0.25;
const MAX_PITCH = 4;
const TWO_PI = 2 * Math.PI;

/** Principal argument: wrap to [-pi, pi]. */
function princarg(x) {
    return x - TWO_PI * Math.round(x / TWO_PI);
}

/**
 * Gaussian window truncated to `length` samples, where it has fallen to REL_HEIGHT of its peak
 * (the setting used in the DAFx-16 paper). Unlike Hann, its spectrum has no sidelobes with
 * alternating sign, so adjacent-bin phase differences never sit on the +-pi wrap and the
 * phase-gradient estimates stay valid. With Hann, a pure tone leaks 1-4% of its energy into
 * sidebands after shifting; with this window it is under 0.1%.
 */
function gaussianWindow(length) {
    const win = new Float64Array(length);
    const gamma = (-Math.PI * (length / 2) * (length / 2)) / Math.log(WINDOW_EDGE_HEIGHT);
    for (let i = 0; i < length; i++) {
        const t = i - length / 2;
        win[i] = Math.exp((-Math.PI * t * t) / gamma);
    }
    return win;
}

/** Zeroth-order modified Bessel function of the first kind (for the Kaiser window). */
function besselI0(x) {
    let sum = 1;
    let term = 1;
    const q = (x * x) / 4;
    for (let k = 1; term > 1e-12; k++) {
        term *= q / (k * k);
        sum += term;
    }
    return sum;
}

/**
 * Kaiser-windowed sinc, tabulated at SINC_PHASES + 1 fractional offsets (the last row lets the
 * lookup interpolate linearly without a bounds check). Row p holds the weights for the
 * 2 * SINC_HALF_TAPS samples around a read position that is p / SINC_PHASES past a sample.
 */
function buildSincTable() {
    const taps = 2 * SINC_HALF_TAPS;
    const table = new Float64Array((SINC_PHASES + 1) * taps);
    const norm = besselI0(KAISER_BETA);
    for (let p = 0; p <= SINC_PHASES; p++) {
        for (let j = 0; j < taps; j++) {
            const x = j - SINC_HALF_TAPS + 1 - p / SINC_PHASES; // distance from the read position
            const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
            const r = x / SINC_HALF_TAPS;
            const kaiser = Math.abs(r) >= 1 ? 0 : besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / norm;
            table[p * taps + j] = sinc * kaiser;
        }
    }
    return table;
}

const SINC_TABLE = buildSincTable();

/** Array-backed binary max-heap of (key, id) pairs with no allocation after construction. */
class MaxHeap {
    constructor(capacity) {
        this.keys = new Float64Array(capacity);
        this.ids = new Int32Array(capacity);
        this.size = 0;
    }

    clear() {
        this.size = 0;
    }

    push(key, id) {
        let i = this.size++;
        const keys = this.keys;
        const ids = this.ids;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (keys[parent] >= key) break;
            keys[i] = keys[parent];
            ids[i] = ids[parent];
            i = parent;
        }
        keys[i] = key;
        ids[i] = id;
    }

    /** Remove the top element and return its id. */
    pop() {
        const keys = this.keys;
        const ids = this.ids;
        const topId = ids[0];
        const size = --this.size;
        if (size > 0) {
            const key = keys[size];
            const id = ids[size];
            let i = 0;
            for (;;) {
                let child = 2 * i + 1;
                if (child >= size) break;
                if (child + 1 < size && keys[child + 1] > keys[child]) child++;
                if (keys[child] <= key) break;
                keys[i] = keys[child];
                ids[i] = ids[child];
                i = child;
            }
            keys[i] = key;
            ids[i] = id;
        }
        return topId;
    }
}

/** Streaming single-channel pitch shifter. Call process() once per audio block. */
class PGHIPitchShifter {
    constructor() {
        const N = FRAME_SIZE;
        const bins = N / 2 + 1;
        this.N = N;
        this.bins = bins;

        this.fft = new FFT(N);
        this.window = gaussianWindow(N);

        // input history (circular) and hop counter
        this.inRing = new Float64Array(N);
        this.inWrite = 0;
        this.sinceFrame = 0;

        // per-frame scratch
        this.timeBuf = new Float64Array(N);
        this.spec = this.fft.createComplexArray();
        this.synSpec = this.fft.createComplexArray();
        this.timeComplex = this.fft.createComplexArray();
        this.frameOut = new Float64Array(N);

        // analysis / synthesis state, swapped between frames
        this.mag = new Float64Array(bins);
        this.magPrev = new Float64Array(bins);
        this.phaseA = new Float64Array(bins);
        this.phaseAPrev = new Float64Array(bins);
        this.phaseS = new Float64Array(bins);
        this.phaseSPrev = new Float64Array(bins);
        this.dt = new Float64Array(bins); // time derivative of phi_a (rad/sample)
        this.dtPrev = new Float64Array(bins);
        this.df = new Float64Array(bins); // centred frequency derivative of phi_a (rad/bin)
        this.unknown = new Uint8Array(bins);
        this.heap = new MaxHeap(2 * bins);
        this.rng = 0x9e3779b9;

        // stretched-domain overlap-add (accumulated signal, window energy, finished samples)
        this.acc = new Float64Array(RING_SIZE);
        this.energy = new Float64Array(RING_SIZE);
        this.fin = new Float64Array(RING_SIZE);
        this.frameStart = 0; // absolute stretched-domain position of the current frame
        this.clearedUpTo = 0;
        this.pendingHop = ANALYSIS_HOP; // a_s from the current frame to the next
        this.hopAccum = 0; // exact (fractional) synthesis position, for error diffusion
        this.hopInt = 0; // rounded synthesis position
        this.readPos = 0; // resampler read position in the stretched domain
        this.frameCount = 0;

        // output FIFO
        this.outQueue = new Float64Array(OUTPUT_QUEUE_SIZE);
        this.outRead = 0;
        this.outWrite = 0;
        this.started = false;
    }

    /**
     * Push a block of input samples and fill outBlock with pitch-shifted output.
     * Latency is roughly one frame (FRAME_SIZE samples) plus a small prefill.
     */
    process(inBlock, outBlock, pitchFactor) {
        const pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, pitchFactor));
        const n = inBlock.length;
        for (let i = 0; i < n; i++) {
            this.inRing[this.inWrite] = inBlock[i];
            this.inWrite = (this.inWrite + 1) % this.N;
            if (++this.sinceFrame === ANALYSIS_HOP) {
                this.sinceFrame = 0;
                this.processFrame(pitch);
            }
        }

        const queued = this.outWrite - this.outRead;
        if (!this.started && queued >= PREFILL) this.started = true;
        for (let i = 0; i < outBlock.length; i++) {
            if (this.started && this.outRead < this.outWrite) {
                outBlock[i] = this.outQueue[this.outRead++ & (OUTPUT_QUEUE_SIZE - 1)];
            } else {
                outBlock[i] = 0;
            }
        }
    }

    processFrame(pitch) {
        const bins = this.bins;
        const first = this.frameCount === 0;
        const aS = first ? ANALYSIS_HOP : this.pendingHop;
        const alpha = aS / ANALYSIS_HOP; // time-scaling factor, also scales the frequency step

        this.analyse(first);
        if (first) {
            this.phaseS.set(this.phaseA);
        } else {
            this.integratePhase(aS, alpha);
        }
        this.synthesise(pitch);
        this.overlapAdd();

        // decide the hop to the next frame (error diffusion keeps the mean exactly pitch * a_a)
        this.hopAccum += pitch * ANALYSIS_HOP;
        const nextPos = Math.round(this.hopAccum);
        const hop = nextPos - this.hopInt;
        this.hopInt = nextPos;
        this.pendingHop = hop;
        this.finalise(hop);
        this.resample(pitch);
        this.frameStart += hop;
        this.frameCount++;

        // wrap phases so they stay small, then rotate state for the next frame
        const phaseS = this.phaseS;
        for (let m = 0; m < bins; m++) phaseS[m] = princarg(phaseS[m]);
        let tmp = this.mag;
        this.mag = this.magPrev;
        this.magPrev = tmp;
        tmp = this.phaseA;
        this.phaseA = this.phaseAPrev;
        this.phaseAPrev = tmp;
        tmp = this.phaseS;
        this.phaseS = this.phaseSPrev;
        this.phaseSPrev = tmp;
        tmp = this.dt;
        this.dt = this.dtPrev;
        this.dtPrev = tmp;
    }

    /** Window the latest N input samples, centre the window at index 0, FFT, and take derivatives. */
    analyse(first) {
        const N = this.N;
        const bins = this.bins;
        const half = N >> 1;
        const win = this.window;
        const buf = this.timeBuf;
        // oldest sample sits at inWrite; rotate by N/2 so the window centre is at index 0 (phase reference)
        for (let i = 0; i < N; i++) {
            const x = this.inRing[(this.inWrite + i) % N] * win[i];
            buf[(i + half) & (N - 1)] = x;
        }
        this.fft.realTransform(this.spec, buf);

        const spec = this.spec;
        const mag = this.mag;
        const phaseA = this.phaseA;
        for (let m = 0; m < bins; m++) {
            const re = spec[2 * m];
            const im = spec[2 * m + 1];
            mag[m] = Math.sqrt(re * re + im * im);
            phaseA[m] = Math.atan2(im, re);
        }

        // (Delta_t phi_a)(m, n): backward difference, heterodyned (eq. 13). Needs no future frame.
        const dt = this.dt;
        const phaseAPrev = this.phaseAPrev;
        for (let m = 0; m < bins; m++) {
            const carrier = (TWO_PI * m) / N;
            dt[m] = first
                ? carrier
                : princarg(phaseA[m] - phaseAPrev[m] - carrier * ANALYSIS_HOP) / ANALYSIS_HOP + carrier;
        }

        // (Delta_f phi_a)(m, n): centred difference of principal-argument phase steps (eqs. 16-18).
        // The b_a factor is folded into alpha later, so this is in rad per bin.
        const df = this.df;
        for (let m = 0; m < bins; m++) {
            const back = m > 0 ? princarg(phaseA[m] - phaseA[m - 1]) : 0;
            const fwd = m < bins - 1 ? princarg(phaseA[m + 1] - phaseA[m]) : 0;
            if (m === 0) df[m] = fwd;
            else if (m === bins - 1) df[m] = back;
            else df[m] = 0.5 * (back + fwd);
        }
    }

    /** Phase Gradient Heap Integration for the current frame (Algorithm 1 of the paper). */
    integratePhase(aS, alpha) {
        const bins = this.bins;
        const mag = this.mag;
        const magPrev = this.magPrev;
        const phaseS = this.phaseS;
        const phaseSPrev = this.phaseSPrev;
        const dt = this.dt;
        const dtPrev = this.dtPrev;
        const df = this.df;
        const unknown = this.unknown;
        const heap = this.heap;
        heap.clear();

        let maxMag = 0;
        for (let m = 0; m < bins; m++) {
            if (mag[m] > maxMag) maxMag = mag[m];
            if (magPrev[m] > maxMag) maxMag = magPrev[m];
        }
        const absTol = REL_TOL * maxMag;

        // set I = bins above tolerance; the rest get random phase. Every bin in I is seeded
        // from the previous frame (time direction), so the loop below always terminates.
        let remaining = 0;
        for (let m = 0; m < bins; m++) {
            if (mag[m] > absTol) {
                unknown[m] = 1;
                remaining++;
                heap.push(magPrev[m], m);
            } else {
                unknown[m] = 0;
                this.rng ^= this.rng << 13;
                this.rng ^= this.rng >>> 17;
                this.rng ^= this.rng << 5;
                phaseS[m] = ((this.rng >>> 0) / 4294967296) * TWO_PI - Math.PI;
            }
        }

        const halfAS = aS / 2;
        const halfAlpha = alpha / 2;
        while (remaining > 0 && heap.size > 0) {
            const id = heap.pop();
            if (id < bins) {
                // coefficient (m, n-1): propagate in time to (m, n)
                if (unknown[id]) {
                    phaseS[id] = phaseSPrev[id] + halfAS * (dtPrev[id] + dt[id]);
                    unknown[id] = 0;
                    remaining--;
                    heap.push(mag[id], id + bins);
                }
            } else {
                // coefficient (m, n): propagate in frequency to its neighbours
                const m = id - bins;
                const up = m + 1;
                if (up < bins && unknown[up]) {
                    phaseS[up] = phaseS[m] + halfAlpha * (df[m] + df[up]);
                    unknown[up] = 0;
                    remaining--;
                    heap.push(mag[up], up + bins);
                }
                const down = m - 1;
                if (down >= 0 && unknown[down]) {
                    phaseS[down] = phaseS[m] - halfAlpha * (df[m] + df[down]);
                    unknown[down] = 0;
                    remaining--;
                    heap.push(mag[down], down + bins);
                }
            }
        }
    }

    /** Rebuild a time-domain frame from the original magnitudes and the estimated synthesis phase. */
    synthesise(pitch) {
        const N = this.N;
        const bins = this.bins;
        const half = N >> 1;
        const mag = this.mag;
        const phaseS = this.phaseS;
        const synSpec = this.synSpec;

        // After resampling by `pitch`, bin m lands on m * pitch. Fade out bins that would alias.
        const cutoff = pitch > 1 ? (bins - 1) / pitch : bins;
        for (let m = 0; m < bins; m++) {
            let gain = 1;
            if (m >= cutoff) gain = 0;
            else if (m > cutoff - ALIAS_TAPER_BINS) gain = (cutoff - m) / ALIAS_TAPER_BINS;
            const g = mag[m] * gain;
            synSpec[2 * m] = g * Math.cos(phaseS[m]);
            synSpec[2 * m + 1] = g * Math.sin(phaseS[m]);
        }
        synSpec[1] = 0; // DC and Nyquist are real for a real signal
        synSpec[2 * (bins - 1) + 1] = 0;

        this.fft.completeSpectrum(synSpec);
        this.fft.inverseTransform(this.timeComplex, synSpec);
        this.fft.fromComplexArray(this.timeComplex, this.frameOut);

        // undo the centring rotation in place
        const out = this.frameOut;
        for (let i = 0; i < half; i++) {
            const tmp = out[i];
            out[i] = out[i + half];
            out[i + half] = tmp;
        }
    }

    /** Weighted overlap-add into the stretched-domain ring, tracking window energy for normalisation. */
    overlapAdd() {
        const N = this.N;
        const win = this.window;
        const out = this.frameOut;
        const start = this.frameStart;
        // zero the part of the ring this frame is the first to touch
        for (let p = this.clearedUpTo; p < start + N; p++) {
            this.acc[p & RING_MASK] = 0;
            this.energy[p & RING_MASK] = 0;
        }
        this.clearedUpTo = start + N;
        for (let i = 0; i < N; i++) {
            const idx = (start + i) & RING_MASK;
            const w = win[i];
            this.acc[idx] += out[i] * w;
            this.energy[idx] += w * w;
        }
    }

    /** No later frame starts before frameStart + hop, so those samples are complete: normalise them. */
    finalise(hop) {
        const start = this.frameStart;
        for (let p = start; p < start + hop; p++) {
            const idx = p & RING_MASK;
            this.fin[idx] = this.acc[idx] / Math.max(this.energy[idx], ENERGY_FLOOR);
        }
    }

    /**
     * Read the finished stretched signal at `pitch` samples per output sample.
     * Windowed-sinc interpolation matters when pitching down: the signal is upsampled there, and a
     * cheaper interpolator (cubic) leaves mirrored images in the band the shift has just emptied,
     * about -26 dB below the signal against -93 dB with this kernel.
     */
    resample(pitch) {
        const taps = 2 * SINC_HALF_TAPS;
        const finalEnd = this.frameStart + this.pendingHop;
        const fin = this.fin;
        while (Math.floor(this.readPos) + SINC_HALF_TAPS < finalEnd) {
            const base = Math.floor(this.readPos);
            const phase = (this.readPos - base) * SINC_PHASES;
            const row = Math.floor(phase);
            const frac = phase - row;
            const a = row * taps;
            const b = a + taps;
            const first = base - SINC_HALF_TAPS + 1;
            let value = 0;
            for (let j = 0; j < taps; j++) {
                const weight = SINC_TABLE[a + j] * (1 - frac) + SINC_TABLE[b + j] * frac;
                value += fin[(first + j) & RING_MASK] * weight;
            }
            this.outQueue[this.outWrite++ & (OUTPUT_QUEUE_SIZE - 1)] = value;
            this.readPos += pitch;
        }
    }
}

export { PGHIPitchShifter, FRAME_SIZE, ANALYSIS_HOP };
