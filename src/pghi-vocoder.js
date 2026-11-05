import { PGHIPitchShifter } from "./pghi.js";

const SILENCE = new Float32Array(128);

/** AudioWorklet wrapper: one independent PGHIPitchShifter per channel. */
class PGHIVocoderProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            {
                name: "pitchFactor",
                defaultValue: 1.0,
            },
        ];
    }

    constructor(options) {
        super(options);
        this.shifters = [];
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        const pitchFactor = parameters.pitchFactor[parameters.pitchFactor.length - 1];

        // an unconnected or paused input arrives as zero channels: keep the pipeline flowing with silence
        const nbIn = input.length;
        for (let ch = 0; ch < output.length; ch++) {
            if (!this.shifters[ch]) this.shifters[ch] = new PGHIPitchShifter();
            if (ch > 0 && nbIn === 1) {
                // mono source feeding a stereo output: reuse channel 0 instead of running the same DSP twice
                output[ch].set(output[0]);
                continue;
            }
            const source = input[ch] || SILENCE;
            this.shifters[ch].process(source, output[ch], pitchFactor);
        }
        return true;
    }
}

registerProcessor("pghi-processor", PGHIVocoderProcessor);
