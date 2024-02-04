(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
class EqualizerNode extends GainNode {
    constructor(audioContext) {
        super(audioContext);
        this.audioContext = audioContext;
        // Define your equalizer bands
        const equalizerBands = [
            { f: 60, type: 'lowshelf' },
            { f: 250, type: 'peaking' },
            { f: 1000, type: 'peaking' },
            { f: 4000, type: 'peaking' },
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
},{}],2:[function(require,module,exports){
const EqualizerNode = require('./equalizer');

class AudioPlayer {
    constructor(audioContext) {
      this.audioContext = audioContext;
      this.audioElement = document.getElementById('audio-player');
      this.sourceNode = this.audioContext.createMediaElementSource(this.audioElement);
    }
  
    loadSong(url) {
        this.audioElement.src = url;
    }
  
    play() {
      if (this.audioElement) {
        this.audioElement.play();
      }
    }
  
    pause() {
      if (this.audioElement) {
        this.audioElement.pause();
      }
    }
  
    seek(timeInSeconds) {
      if (this.audioElement) {
        this.audioElement.currentTime = timeInSeconds;
      }
    }
  
    get playbackRate() {
      return this.audioElement ? this.audioElement.playbackRate : null;
    }
  
    set playbackRate(rate) {
      if (this.audioElement) {
        this.audioElement.playbackRate = rate;
      }
    }
  
    get node() {
      return this.sourceNode;
    }
  
    set node(newNode) {
      if (this.sourceNode) {
        this.sourceNode.disconnect();
      }
      this.sourceNode = newNode;
      if (this.sourceNode) {
        this.sourceNode.connect(this.audioContext.destination);
      }
    }
  }


class Song {
  constructor(id, name, path) {
    this.id = id;
    this.name = name;
    this.path = path;
  }
}

class Playlist {
    constructor(...items) {
        this.songs = [];
        this.songIndex = 0;
        this.repeatSongIndex = null;  
        for (let song of items) {
            if (Array.isArray(song) && song.length === 3) {
              this.addSong(...song);
            }
        }
    }

    addSong(id, name, path) {
        this.songs.push(new Song(id, name, path));
    }

    get currentSong() {
        return this.songs[this.songIndex];
    }

    set currentSong(songIndex) {
        this.songIndex = songIndex;
    }

    get repeatSong() {
        return this.repeatSongIndex;
    }

    set repeatSong(songIndex) {
        this.repeatSongIndex = songIndex;
    }

    nextSong() {
        if (this.repeatSongIndex !== null)
            this.songIndex = this.repeatSongIndex - 1; 

        this.songIndex = (this.songIndex + 1) % this.songs.length;
        return this.currentSong;
      }

    previousSong() {
        if (this.repeatSongIndex !== null)
            this.songIndex = this.repeatSongIndex + 1;

        this.songIndex--;
        if (this.songIndex < 0)
            this.songIndex = this.songs.length - 1;
        return this.currentSong;
    }

    deleteSong(songIndex) {
        if (songIndex < 0 || songIndex >= this.length) {
            throw new Error('Invalid song index');
        }

        if (songIndex === this.repeatSongIndex) {
            this.repeatSongIndex = null;
        }
        
        // if the song to be deleted is before the repeated song, shift the repeated song index
        if (this.repeatSongIndex !== null && this.repeatSongIndex > songIndex) {
            this.repeatSongIndex--;
        }


        this.songs.splice(songIndex, 1);
        // reindex
        this.songs.forEach((song, index) => {
            song.id = index;
        })
    }
}

let playlist = new Playlist(
  [0, 'Mia & Sebastian\'s Theme - Arr. Mercuzio', `music/Mia & Sebastian's Theme - Arr. Mercuzio.mp3`],
);

let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let audioPlayer = new AudioPlayer(audioContext);

let speedFactor = 0.0;
let pitchFactor = 0.0;

let playerEngine, phaseVocoderNode, equalizer, analyser, pitchFactorParam;

async function loadSong(initial){
    $forwardButton.classList.add('disabled');
    $backwardButton.classList.add('disabled');
    if (audioContext.audioWorklet === undefined) {
      let $noWorklet = document.querySelector("#no-worklet");
      $noWorklet.style.display = 'block';
      let $controls = document.querySelector(".controls");
      $controls.style.display = 'none';
      return;
    }
    if (playlist.songs.length === 0) {
      return;
    }
    $("h1").text( playlist.currentSong.name );
    stopAnimation(); 
    
    let oldEqualizer = initial ? null : equalizer.getGains();
    if (window.performance && performance.memory) {
      console.log(`Total Memory: ${performance.memory.totalJSHeapSize / (1024 * 1024)} MB`, '\n',
      `Used Memory: ${performance.memory.usedJSHeapSize / (1024 * 1024)} MB`, '\n',
      `Limit: ${performance.memory.jsHeapSizeLimit / (1024 * 1024)} MB`);
    }
    
    audioPlayer.loadSong(playlist.currentSong.path);
    await setupEngine(initial);
    
    //setting up pitch slider
    pitchFactorParam = phaseVocoderNode.parameters.get('pitchFactor');
    if (!initial){
        let oldPitch = $pitchvalueLabel.innerHTML
        let oldSpeed = $valueLabel.innerHTML;
        audioPlayer.playbackRate = Math.pow(2, parseFloat(oldSpeed)/12);
        pitchFactorParam.value = Math.pow(2, parseFloat(oldPitch)/12);
        equalizer.setGains(oldEqualizer);
    }

    startAnimation();

    if (!initial) 
        audioPlayer.play();

    $forwardButton.classList.remove('disabled');
    $backwardButton.classList.remove('disabled');

}

async function setupEngine(initial) {
    if (!initial) {
        playerEngine.disconnect();
        phaseVocoderNode.disconnect();
        equalizer.disconnect();
        analyser.disconnect();
    }
    playerEngine = audioPlayer.node;

    await audioContext.audioWorklet.addModule('./dist/phase-vocoder.js');
    phaseVocoderNode = new AudioWorkletNode(audioContext, 'phase-vocoder-processor', { outputChannelCount: [2] });
    equalizer = new EqualizerNode(audioContext);
    analyser = audioContext.createAnalyser();

    playerEngine.connect(phaseVocoderNode);
    phaseVocoderNode.connect(equalizer);
    equalizer.connect(analyser);
    analyser.connect(audioContext.destination);
}


let $forwardButton = document.querySelector('#forward');
let $backwardButton = document.querySelector('#backward');

$forwardButton.addEventListener('click', async ()=>{
    playlist.nextSong();
    loadSong(false);

});

$backwardButton.addEventListener('click', async ()=>{
    playlist.previousSong();
    loadSong(false);
});



let audioElement = audioPlayer.audioElement;
audioElement.addEventListener('play', function() {
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
  });

audioElement.addEventListener('ended', function() {
    playlist.nextSong();
    loadSong(false);
});



let $speedSlider = document.querySelector('#speed');
let $valueLabel = document.querySelector('#speed-value');
$speedSlider.addEventListener('input', function() {
    speedFactor = Math.pow(2, parseFloat(this.value)/12);
    // playControl.speed = speedFactor;
    audioPlayer.playbackRate = speedFactor;
    $valueLabel.innerHTML = this.value;
}, false);


let $pitchSlider = document.querySelector('#pitch');
let $pitchvalueLabel = document.querySelector('#pitch-value');
$pitchSlider.addEventListener('input', function() {
    pitchFactor = this.value;
    pitchFactorParam.value = Math.pow(2, parseFloat(this.value)/ 12);
    $pitchvalueLabel.innerHTML = this.value;
}, false);

let $equalizer = document.querySelector('#equalizer');
let $equalizerLabel = document.querySelector('#equalizer-value');
let $frequencySelect = document.querySelector('#frequency-select');
$equalizer.addEventListener('input', function() {
    let frequency = $frequencySelect.value;
    let gain = this.value;
    equalizer.setGain(parseFloat(frequency), parseFloat(gain));
    $equalizerLabel.innerHTML = this.value;
}, false);

$frequencySelect.addEventListener('change', function() {
    let frequency = this.value;
    let gain = equalizer.getGain(parseFloat(frequency));
    $equalizer.value = gain;
    $equalizerLabel.innerHTML = gain;
}, false);


let requestId;
// cursor animation loop
async function loop() {
    requestId = undefined;

    let array = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(array);
    let canvas = document.getElementById('canvas'),
        cwidth = canvas.width,
        cheight = canvas.height - 2,
        meterWidth = 10, //width of the meters in the spectrum
        capHeight = 2,
        capStyle = '#fff',
        meterNum = 800 / (10 + 2), //count of the meters
        capYPositionArray = [],////store the vertical position of hte caps for the preivous frame
        ctx = canvas.getContext('2d'),
    gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(1, '#FF0099');
    gradient.addColorStop(0.5, '#FF00FF');
    gradient.addColorStop(0, '#FF99FF');
    let step = Math.round(array.length / meterNum); //sample limited data from the total array
    ctx.clearRect(0, 0, cwidth, cheight);
    for (let i = 0; i < meterNum; i++) {
        let value = array[i * step];
        if (capYPositionArray.length < Math.round(meterNum)) {
            capYPositionArray.push(value);
        };
        ctx.fillStyle = capStyle;
        //draw the cap, with transition effect
        if (value < capYPositionArray[i]) {
            ctx.fillRect(i * 12, cheight - (--capYPositionArray[i]), meterWidth, capHeight);
        } else {
            ctx.fillRect(i * 12, cheight - value, meterWidth, capHeight);
            capYPositionArray[i] = value;
        };
        ctx.fillStyle = gradient; //set the filllStyle to gradient for a better look
        ctx.fillRect(i * 12 /*meterWidth+gap*/ , cheight - value + capHeight, meterWidth, cheight); //the meter
    }

    startAnimation();
}

function startAnimation(){
    if (!requestId)
        requestId = requestAnimationFrame(loop);
}
function stopAnimation() {
    if (requestId) {
       cancelAnimationFrame(requestId);
       requestId = undefined;
    }
}

function initAudio(data) {
    let audioContext = new AudioContext();
    let audioRequest = new XMLHttpRequest();
    let dfd = jQuery.Deferred();

    audioRequest.open("GET", URL.createObjectURL(data.files[0]), true);
    audioRequest.responseType = "arraybuffer";
    audioRequest.onload = function () {
        audioContext.decodeAudioData(audioRequest.response,
                function (buffer) {
                    dfd.resolve(buffer);
                });
    }
    audioRequest.send();
    return dfd.promise();
}

window.extract = (data) => {
    let files = data.files;
    for(let i = 0; i < files.length; i++) {
        let file = files[i];
        let file_name = file.name.split('.').slice(0, -1).join('.');
        $.when(initAudio(data)).done(function (b) {
            $('.playlist').append(
                `<div class=playlist-row id=${playlist.songs.length} onclick="nav(this.id)"> ${file_name} 
                    <button class="delete-button" onclick="deleteSong(this.parentElement.id); event.stopPropagation();">Delete</button>
                    <button class="repeat-button" onclick="repeatSong(this.parentElement.id); event.stopPropagation();">Repeat</button>
                </div>`
            );
            playlist.addSong(playlist.songs.length, file_name, URL.createObjectURL(file));
        });
    }
}

window.nav = function (id){
    id = parseInt(id);
    playlist.currentSong = id;
    loadSong(false);
}

window.deleteSong = function (id){
    id = parseInt(id);
    playlist.deleteSong(id);
    $(`#${id}`).remove();
    $('.playlist-row').each(function(index){
        $(this).attr('id', index);
    });
}

window.repeatSong = function (id){
    id = parseInt(id);
    let changeColor = (id, enable) => {
        let elementDiv = $(`#${id}`);
        if (enable){
            elementDiv.css("background-color", "pink");
        } else {
          elementDiv.css("background-color", "initial");
        }
    }

    if (playlist.repeatSong === id){ // if repeat is already set, unset it
        changeColor(id, false);
        playlist.repeatSong = null;
    } else if (playlist.repeatSong !== null){ // if another repeat is set, unset it
        changeColor(playlist.repeatSong, false);
        playlist.repeatSong = id;
        changeColor(id, true);
    } else { // set repeat
        playlist.repeatSong = id;
        changeColor(id, true);
    }
} 


window.onload = async function() {
    for (let i=0; i<playlist.songs.length; i++){
        $('.playlist').append(
            `<div class=playlist-row id=${playlist.songs[i].id} onclick="nav(this.id)"> ${playlist.songs[i].name} 
                <button class="delete-button" onclick="deleteSong(this.parentElement.id); event.stopPropagation();">Delete</button>
                <button class="repeat-button" onclick="repeatSong(this.parentElement.id); event.stopPropagation();">Repeat</button>
            </div>`
        );
    }
    await loadSong(true); // load first song
}
},{"./equalizer":1}]},{},[2]);
