import assert from "node:assert/strict";
import { conv2d, elu, maxPool2, predict } from "../src/keycnn.js";

// 3x3 ones kernel, pad 1, on a 3x3 ramp: each output is the sum of its in-bounds neighbourhood.
const x = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
const ones = new Float32Array(9).fill(1);
let y = conv2d(x, 1, 3, 3, ones, [0.5], 1, 3, 3, 1);
assert.deepEqual([...y.data], [12.5, 21.5, 16.5, 27.5, 45.5, 33.5, 24.5, 39.5, 28.5]);

// Cross-correlation, not convolution: a kernel with a single 1 at (0, 0) reads the up-left neighbour.
const corner = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0]);
y = conv2d(x, 1, 3, 3, corner, [0], 1, 3, 3, 1);
assert.deepEqual([...y.data], [0, 0, 0, 0, 1, 2, 0, 4, 5]);

// No padding shrinks the output; two input channels add up.
y = conv2d(new Float32Array(18).fill(1), 2, 3, 3, new Float32Array(18).fill(1), [0], 1, 3, 3, 0);
assert.equal(y.h, 1);
assert.deepEqual([...y.data], [18]);

const e = Float32Array.from([1, -1]);
elu(e);
assert.ok(Math.abs(e[1] - (Math.exp(-1) - 1)) < 1e-6 && e[0] === 1);

assert.deepEqual([...maxPool2(Float32Array.from([1, 5, 2, 3, 4, 0, 7, 1, 9, 2, 3, 3]), 1, 3, 4).data], [5, 7]);

// End to end on a tiny model: probabilities sum to 1 and silence is handled.
const model = {
    labels: ["C major", "C minor"], frames: 4, bins: 3, bands: 2,
    filterbank: Float32Array.from([1, 0, 0, 1, 1, 1]),
    layers: [{ in: 1, out: 2, kt: 1, kf: 1, pad: 0, pool: false, weight: Float32Array.from([1, -1]), bias: Float32Array.from([0, 0]) }],
};
const p = predict(model, new Float32Array(44100));
assert.equal(p.length, 2);
assert.ok(Math.abs(p[0] + p[1] - 1) < 1e-6);

console.log("keycnn tests passed");
