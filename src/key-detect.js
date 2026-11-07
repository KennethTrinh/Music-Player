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

let worker = null;
let nextId = 0;
const pending = new Map();

function getWorker() {
    if (!worker) {
        worker = new Worker(new URL(WORKER_URL, document.baseURI));
        worker.onmessage = ({ data }) => {
            const { resolve, reject } = pending.get(data.id);
            pending.delete(data.id);
            if (data.error) reject(new Error(data.error));
            else resolve(data);
        };
    }
    return worker;
}

/** "Bb major" -> { tonic: 10, isMinor: false, name: "Bb" }, "F# minor" -> name "F#m". */
function parseLabel(label) {
    const [note, mode] = label.split(" ");
    const names = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
    const spellings = ["C", "Db", "D", "D#", "E", "F", "Gb", "G", "G#", "A", "A#", "B"];
    const tonic = names.includes(note) ? names.indexOf(note) : spellings.indexOf(note);
    const isMinor = mode === "minor";
    return { tonic, isMinor, name: names[tonic] + (isMinor ? "m" : "") };
}

/** Detects the key of an encoded audio file (ArrayBuffer, consumed). Resolves null for silence. */
export async function detectKey(arrayBuffer) {
    const decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(arrayBuffer);
    const length = Math.min(decoded.length, WINDOW_SAMPLES);
    const offset = Math.floor((decoded.length - length) / 2);

    const mono = new Float32Array(length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
        const data = decoded.getChannelData(c).subarray(offset, offset + length);
        for (let i = 0; i < length; i++) mono[i] += data[i] / decoded.numberOfChannels;
    }
    if (!mono.some((s) => Math.abs(s) > 1e-4)) return null;

    const id = nextId++;
    const result = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        getWorker().postMessage(
            { id, samples: mono, weightsUrl: new URL(WEIGHTS_URL, document.baseURI).href },
            [mono.buffer],
        );
    });
    const best = result.probabilities.reduce((b, p, i, all) => (p > all[b] ? i : b), 0);
    return { ...parseLabel(result.labels[best]), confidence: result.probabilities[best] };
}
