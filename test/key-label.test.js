import assert from "node:assert/strict";

globalThis.window = {};
const { keyLabel, keyFullName } = await import("../src/key-detect.js");

const am = { tonic: 9, isMinor: true };
assert.equal(keyLabel(am), "Am");
assert.equal(keyLabel(am, 3), "Cm");
assert.equal(keyLabel(am, -12), "Am");
assert.equal(keyLabel(am, -10), "Bm"); // wraps below zero
assert.equal(keyLabel({ tonic: 10, isMinor: false }, 2), "C");
assert.equal(keyLabel({ tonic: 0, isMinor: false }, -1), "B");
assert.equal(keyFullName(am, 3), "C minor");
assert.equal(keyFullName({ tonic: 3, isMinor: false }), "Eb major");
console.log("key-label tests passed");
