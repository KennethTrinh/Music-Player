#!/usr/bin/env python3
"""Write models/keycnn.bin, the weight file src/keycnn.js loads, from pitchify's compiled Core ML key model.

    python tools/export_keycnn_web.py ../pitchify/ios/Pitchify/Models/KeyCNN.mlpackage models/keycnn.bin

Pure Python, no dependencies. pitchify's build_model.py already folded batch norm into the convolutions, flipped the
kernels and stored everything as float16 in (out, in, kt, kf) order, so the blobs in weight.bin are copied as they
are. Layout of the output: u32 LE header length, JSON header, float16 LE tensors: filterbank (bins x bands), then
each layer's weight and bias. The layer table below is read off the model's graph (conv pad / max_pool placement)
and checked against the blob sizes. The weights are CC BY-NC-SA 4.0 (madmom's model license).
"""
import json
import re
import struct
import sys

src = sys.argv[1] if len(sys.argv) > 1 else "KeyCNN.mlpackage"
dst = sys.argv[2] if len(sys.argv) > 2 else "models/keycnn.bin"

BINS, BANDS, FRAMES = 389, 105, 300
# (in, out, kernel, pad, max-pool after)
LAYERS = [
    (1, 24, 5, 2, False),
    (24, 24, 3, 1, True),
    (24, 48, 3, 1, False),
    (48, 48, 3, 1, True),
    (48, 96, 3, 1, False),
    (96, 96, 3, 1, True),
    (96, 192, 3, 1, False),
    (192, 192, 3, 1, False),
    (192, 24, 1, 0, False),
]

root = f"{src}/Data/com.apple.CoreML"
blob = open(f"{root}/weights/weight.bin", "rb").read()
model = open(f"{root}/model.mlmodel", "rb").read()
labels = re.search(rb"A major[ -~]*", model).group().decode("ascii").split(",")
assert len(labels) == 24, labels

# weight.bin: 64-byte file header, then each blob = 64-byte header (magic, dtype, size, data offset) + data.
blobs, pos = [], 64
while pos < len(blob):
    magic, dtype, size, offset = struct.unpack("<IIQQ", blob[pos:pos + 24])
    assert magic == 0xDEADBEEF and dtype == 1, "expected float16 blobs"
    blobs.append(blob[offset:offset + size])
    pos = (offset + size + 63) // 64 * 64
assert len(blobs) == 1 + 2 * len(LAYERS), len(blobs)
assert len(blobs[0]) == BINS * BANDS * 2

layers = []
for n, (c_in, c_out, k, pad, pool) in enumerate(LAYERS):
    assert len(blobs[1 + 2 * n]) == c_out * c_in * k * k * 2, f"layer {n} weight size"
    assert len(blobs[2 + 2 * n]) == c_out * 2, f"layer {n} bias size"
    layers.append({"in": c_in, "out": c_out, "kt": k, "kf": k, "pad": pad, "pool": pool})

header = json.dumps({"labels": labels, "frames": FRAMES, "bins": BINS, "bands": BANDS, "layers": layers}).encode()
with open(dst, "wb") as f:
    f.write(struct.pack("<I", len(header)) + header)
    for b in blobs:
        f.write(b)
print(f"wrote {dst}: {len(layers)} conv layers, {len(labels)} labels, {4 + len(header) + sum(map(len, blobs))} bytes")
