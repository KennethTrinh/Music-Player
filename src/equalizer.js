class EqualizerNode extends GainNode {
    constructor(audioContext) {
        super(audioContext);
        this.audioContext = audioContext;
        // Define your equalizer bands
        const equalizerBands = [
            { name: 'Sub-bass', range: [20, 60] },           
            { name: 'Bass', range: [60, 250] },              
            { name: 'Low midrange', range: [250, 500] },     
            { name: 'Midrange', range: [500, 2000] },        
            { name: 'Upper midrange', range: [2000, 4000] }, 
            { name: 'Presence', range: [4000, 6000] },       
            { name: 'Brilliance', range: [6000, 8000] },     
            { name: 'Air', range: [8000, 12000] },           
            { name: 'High frequencies', range: [12000, 20000] } 
        ];
        // Create your biquad filters
        this.biquads = equalizerBands.map((band) => {
            const biquad = this.audioContext.createBiquadFilter();
            biquad.type = 'peaking'
            biquad.frequency.value = (band.range[0] + band.range[1]) / 2;
            biquad.gain.value = 0;
            biquad.Q.value = 1;
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