"use strict";

const OLAProcessor = require('./ola-processor.js');
const FFT = require('fft.js');

const BUFFERED_BLOCK_SIZE = 4096;

function genHannWindow(length) {
    let win = new Float32Array(length);
    for (var i = 0; i < length; i++) {
        win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / length));
    }
    return win;
}

class PhaseVocoderProcessor extends OLAProcessor {
    static get parameterDescriptors() {
        return [{
            name: 'pitchFactor',
            defaultValue: 1.0
        }];
    }

    constructor(options) {
        options.processorOptions = {
            blockSize: BUFFERED_BLOCK_SIZE,
        };
        super(options);

        this.fftSize = this.blockSize;
        this.timeCursor = 0;

        this.hannWindow = genHannWindow(this.blockSize);

        // prepare FFT and pre-allocate buffers
        this.fft = new FFT(this.fftSize);
        this.freqComplexBuffer = this.fft.createComplexArray();
        this.freqComplexBufferShifted = this.fft.createComplexArray();
        this.timeComplexBuffer = this.fft.createComplexArray();
        this.previousPhase = new Float32Array(this.fftSize / 2 + 1);
        this.phaseCumulative = new Float32Array(this.fftSize / 2 + 1);
        this.magnitudes = new Float32Array(this.fftSize / 2 + 1);
        this.peakIndexes = new Int32Array(this.magnitudes.length);
        this.nbPeaks = 0;
    }

    processOLA(inputs, outputs, parameters) {
        // no automation, take last value
        const pitchFactor = parameters.pitchFactor[parameters.pitchFactor.length - 1];

        for (var i = 0; i < this.nbInputs; i++) {
            for (var j = 0; j < inputs[i].length; j++) {
                // big assumption here: output is symetric to input
                var input = inputs[i][j];
                var output = outputs[i][j];

                this.applyHannWindow(input);

                this.fft.realTransform(this.freqComplexBuffer, input);

                this.computeMagnitudes();
                this.findPeaks();
                this.shiftPeaks(pitchFactor);
                // this.shiftSamples(pitchFactor);

                this.fft.completeSpectrum(this.freqComplexBufferShifted);
                this.fft.inverseTransform(this.timeComplexBuffer, this.freqComplexBufferShifted);
                this.fft.fromComplexArray(this.timeComplexBuffer, output);

                this.applyHannWindow(output);
            }
        }

        this.timeCursor += this.hopSize;
    }

    /** Apply Hann window in-place */
    applyHannWindow(input) {
        for (var i = 0; i < this.blockSize; i++) {
            input[i] = input[i] * this.hannWindow[i];
        }
    }

    /** Compute squared magnitudes for peak finding **/
    computeMagnitudes() {
        var i = 0, j = 0;
        while (i < this.magnitudes.length) {
            let real = this.freqComplexBuffer[j];
            let imag = this.freqComplexBuffer[j + 1];
            // no need to sqrt for peak finding
            this.magnitudes[i] = real ** 2 + imag ** 2;
            i+=1;
            j+=2;
        }
    }

    /** Find peaks in spectrum magnitudes **/
    findPeaks(radius = 1) {
        this.nbPeaks = 0;
        let i = radius;
        let end = this.magnitudes.length - radius;
        while (i < end) {
            let mag = this.magnitudes[i];
            // let surroundingIndexes = Array.from({length: radius * 2 + 1}, (_, k) => k - radius).filter(k => k !== 0);
            // if (surroundingIndexes.some(index => this.magnitudes[i + index] >= mag)) {
            //     i++;
            //     continue;
            // }
            if (this.magnitudes[i - radius] >= mag || this.magnitudes[i + radius] >= mag) {
                i++;
                continue;
            }

            this.peakIndexes[this.nbPeaks] = i;
            this.nbPeaks++;
            i += radius; // increment by 1 instead of 2 to check every magnitude
        }
    }

    /** Shift peaks and regions of influence by pitchFactor into new specturm */
    shiftPeaks(pitchFactor) {
        // zero-fill new spectrum
        this.freqComplexBufferShifted.fill(0);

        for (var i = 0; i < this.nbPeaks; i++) {
            let peakIndex = this.peakIndexes[i];
            let peakIndexShifted = Math.round(peakIndex * pitchFactor);

            if (peakIndexShifted > this.magnitudes.length) {
                break;
            }

            // find region of influence
            var startIndex = 0;
            var endIndex = this.fftSize;
            if (i > 0) {
                let peakIndexBefore = this.peakIndexes[i - 1];
                startIndex = peakIndex - Math.floor((peakIndex - peakIndexBefore) / 2);
            }
            if (i < this.nbPeaks - 1) {
                let peakIndexAfter = this.peakIndexes[i + 1];
                endIndex = peakIndex + Math.ceil((peakIndexAfter - peakIndex) / 2);
            }

            // shift whole region of influence around peak to shifted peak
            let startOffset = startIndex - peakIndex;
            let endOffset = endIndex - peakIndex;
            for (var j = startOffset; j < endOffset; j++) {
                let binIndex = peakIndex + j;
                let binIndexShifted = peakIndexShifted + j;

                if (binIndexShifted >= this.magnitudes.length) {
                    break;
                }

                let indexReal = binIndex * 2;
                let indexImag = indexReal + 1;
                let valueReal = this.freqComplexBuffer[indexReal];
                let valueImag = this.freqComplexBuffer[indexImag];
                if (indexReal > this.fftSize) { // nyquist
                    break;
                }
            
                // apply phase correction
                let omegaDelta = 2 * Math.PI * (binIndexShifted - binIndex) / this.fftSize;
                let phaseShiftReal = Math.cos(omegaDelta * this.timeCursor);
                let phaseShiftImag = Math.sin(omegaDelta * this.timeCursor);

                let valueShiftedReal = valueReal * phaseShiftReal - valueImag * phaseShiftImag;
                let valueShiftedImag = valueReal * phaseShiftImag + valueImag * phaseShiftReal;

                let indexShiftedReal = binIndexShifted * 2;
                let indexShiftedImag = indexShiftedReal + 1;
                this.freqComplexBufferShifted[indexShiftedReal] += valueShiftedReal;
                this.freqComplexBufferShifted[indexShiftedImag] += valueShiftedImag;
            }

        }
    }
}

registerProcessor("phase-vocoder-processor", PhaseVocoderProcessor);