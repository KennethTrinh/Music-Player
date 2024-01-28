(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
class EqualizerNode extends GainNode {
    constructor(audioContext) {
        super(audioContext);
        this.audioContext = audioContext;
        // Define your equalizer bands
        const equalizerBands = [
            { f: 32, type: 'lowshelf' },
            { f: 64, type: 'peaking' },
            { f: 125, type: 'peaking' },
            { f: 250, type: 'peaking' },
            { f: 500, type: 'peaking' },
            { f: 1000, type: 'peaking' },
            { f: 2000, type: 'peaking' },
            { f: 4000, type: 'peaking' },
            { f: 8000, type: 'peaking' },
            { f: 16000, type: 'highshelf' }
        ];
        // Create your biquad filters
        this.biquads = equalizerBands.map((band) => {
            const biquad = this.audioContext.createBiquadFilter();
            biquad.type = band.type;
            biquad.frequency.value = band.f;
            biquad.gain.value = 0;
            return biquad;
        });
        // Connect the biquads
        this.biquads.reduce((prev, curr) => {
            prev.connect(curr);
            return curr;
        });

        this.connect(this.biquads[0]);

        // Connect the last biquad to the audio context's destination
        this.biquads[this.biquads.length - 1].connect(this.audioContext.destination);
    }

    getGain(frequency) {
        const biquad = this.biquads.find(biquad => biquad.frequency.value === frequency);
        return biquad ? biquad.gain.value : null;
    }

    setGain(frequency, gain) {
        // const biquads = this.biquads.filter(biquad => biquad.frequency.value === frequency);
        // biquads.forEach(biquad => {
        //     biquad.gain.value = gain;
        // });
        this.biquads.find(biquad => biquad.frequency.value === frequency).gain.value = gain;
    }
    getGains() {
        return this.biquads.map(biquad => {
            return {
                frequency: biquad.frequency.value,
                gain: biquad.gain.value
            };
        });
    }

    setGains(gains) {
        // gains is an array of { frequency: number, gain: number } objects
        gains.forEach(gain => this.setGain(gain.frequency, gain.gain));
    }
}

module.exports = EqualizerNode;
},{}]},{},[1]);
