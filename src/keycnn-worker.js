// Runs the key CNN off the main thread. Loaded on demand by key-detect.js, so none of this is in the main bundle.
import { loadModel, predict } from "./keycnn.js";

let model = null;

self.onmessage = async ({ data: { id, samples, weightsUrl } }) => {
    try {
        if (!model) {
            const response = await fetch(weightsUrl);
            if (!response.ok) throw new Error(`weights: HTTP ${response.status}`);
            model = loadModel(await response.arrayBuffer());
        }
        self.postMessage({ id, probabilities: predict(model, samples), labels: model.labels });
    } catch (error) {
        self.postMessage({ id, error: String(error) });
    }
};
