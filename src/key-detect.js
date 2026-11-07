/**
 * Musical key detection with the key CNN (see keycnn.js). Nothing here is in the initial bundle's hot path: the
 * worker script and the 1.3 MB weight file are fetched the first time a key is requested, and nothing is stored.
 *
 * Decoding has to happen here (OfflineAudioContext isn't available in workers); the middle 60 s are copied out as mono
 * and the decoded buffer is dropped before the worker runs.
 */
const SAMPLE_RATE = 44100;
const WINDOW_SAMPLES = 60 * SAMPLE_RATE;
const WORKER_URL = "dist/keycnn-worker.js";
const WEIGHTS_URL = "models/keycnn.bin";

const TIMEOUT_MS = 120000;
const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

let worker = null;
let nextId = 0;
const pending = new Map();
// Set when the worker script or the weights can't be loaded: every later song would fail the same way, so stop trying.
let unavailable = false;

function failAll(error, fatal) {
    if (fatal) {
        unavailable = true;
        worker?.terminate();
        worker = null;
    }
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
}

function getWorker() {
    if (!worker) {
        worker = new Worker(new URL(WORKER_URL, document.baseURI));
        worker.onmessage = ({ data }) => {
            const request = pending.get(data.id);
            if (!request) return;
            pending.delete(data.id);
            if (data.fatal) {
                unavailable = true;
                worker?.terminate();
                worker = null;
            }
            if (data.error) request.reject(new Error(data.error));
            else request.resolve(data);
        };
        worker.onerror = (event) => failAll(new Error(event.message || "key worker failed to load"), true);
        worker.onmessageerror = () => failAll(new Error("key worker message error"), true);
    }
    return worker;
}

function runInWorker(samples) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("key detection timed out"));
        }, TIMEOUT_MS);
        pending.set(id, {
            resolve: (value) => (clearTimeout(timer), resolve(value)),
            reject: (error) => (clearTimeout(timer), reject(error)),
        });
        getWorker().postMessage(
            { id, samples, weightsUrl: new URL(WEIGHTS_URL, document.baseURI).href },
            [samples.buffer],
        );
    });
}

/** "Bb major" -> { tonic: 10, isMinor: false, name: "Bb" }, "F# minor" -> name "F#m". */
function parseLabel(label) {
    const [note, mode] = label.split(" ");
    const spellings = ["C", "Db", "D", "D#", "E", "F", "Gb", "G", "G#", "A", "A#", "B"];
    const tonic = NAMES.includes(note) ? NAMES.indexOf(note) : spellings.indexOf(note);
    const isMinor = mode === "minor";
    return { tonic, isMinor, name: NAMES[tonic] + (isMinor ? "m" : "") };
}

/** Same as keyLabel but spelled out, e.g. "A minor", "Eb major". */
export function keyFullName(key, semitones = 0) {
    const tonic = (((key.tonic + Math.round(semitones)) % 12) + 12) % 12;
    return `${NAMES[tonic]} ${key.isMinor ? "minor" : "major"}`;
}

/** Name of `key` ({ tonic, isMinor }) after pitch-shifting by `semitones`, e.g. (Am, +3) -> "Cm". */
export function keyLabel(key, semitones = 0) {
    const tonic = (((key.tonic + Math.round(semitones)) % 12) + 12) % 12;
    return NAMES[tonic] + (key.isMinor ? "m" : "");
}

/**
 * Detects the key of an encoded audio file (ArrayBuffer, consumed). Resolves null when there is nothing to report
 * (silence, or the browser / weights can't do it); rejects only for a file that fails to decode or analyse.
 */
export async function detectKey(arrayBuffer) {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (unavailable || !Offline || typeof Worker === "undefined") return null;

    const decoded = await new Offline(1, 1, SAMPLE_RATE).decodeAudioData(arrayBuffer);
    const length = Math.min(decoded.length, WINDOW_SAMPLES);
    const offset = Math.floor((decoded.length - length) / 2);

    const mono = new Float32Array(length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
        const data = decoded.getChannelData(c).subarray(offset, offset + length);
        for (let i = 0; i < length; i++) mono[i] += data[i] / decoded.numberOfChannels;
    }
    if (!mono.some((s) => Math.abs(s) > 1e-4)) return null;

    const result = await runInWorker(mono);
    const best = result.probabilities.reduce((b, p, i, all) => (p > all[b] ? i : b), 0);
    const key = parseLabel(result.labels[best]);
    return key.tonic < 0 ? null : { ...key, confidence: result.probabilities[best] };
}
