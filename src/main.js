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

class AnimationUI {
    constructor() {
        this.requestId = undefined;
        window.addEventListener('resize', this.canvasFreqUpdate.bind(this));
        this.canvasFreqUpdate();

        // time domain
        this.bars = document.querySelectorAll('.bar');
        this.timeDomain = new Float32Array(1024);
        this.loop = this.loop.bind(this);
    }
    canvasFreqUpdate() {
        this.canvas = document.getElementById('canvas');
        this.canvas.width = window.innerWidth * 0.60;
        this.canvas.height = window.innerHeight * 0.5;
        this.cwidth = this.canvas.width;
        this.cheight = this.canvas.height - 2;
        this.meterNum = 80;
        this.meterWidth = this.cwidth / (this.meterNum + (this.canvas.width * 0.01));
        this.capHeight = 3;
        this.capStyle = '#fff';
        this.capYPositionArray = []; // store the vertical position of hte caps for the preivous frame
        this.ctx = this.canvas.getContext('2d');
        this.gradient = this.ctx.createLinearGradient(0, 0, 0, 300);
        this.gradient.addColorStop(1, '#FF0099');
        this.gradient.addColorStop(0.5, '#FF00FF');
        this.gradient.addColorStop(0, '#FF99FF');
        this.frequncyDomain = new Uint8Array(1024);
    }


    startAnimation() {
        if (!this.requestId)
            this.requestId = requestAnimationFrame(this.loop);
    }

    stopAnimation() {
        if (this.requestId) {
            cancelAnimationFrame(this.requestId);
            this.requestId = undefined;
        }
    }

    async loop() {
        this.requestId = undefined;
        let step = Math.round(this.frequncyDomain.length / this.meterNum); // sample limited data from the total array
        analyser.getByteFrequencyData(this.frequncyDomain);
        this.ctx.clearRect(0, 0, this.cwidth, this.cheight);
        for (let i = 0; i < this.meterNum; i++) {
            let value = this.frequncyDomain[i * step] * (this.cheight * 0.0040);
            if (this.capYPositionArray.length < Math.round(this.meterNum)) {
                this.capYPositionArray.push(value);
            }
            this.ctx.fillStyle = this.capStyle;
            // draw the cap, with transition effect
            if (value < this.capYPositionArray[i]) {
                this.ctx.fillRect(i * 12, this.cheight - (--this.capYPositionArray[i]), this.meterWidth, this.capHeight);
            } else {
                this.ctx.fillRect(i * 12, this.cheight - value, this.meterWidth, this.capHeight);
                this.capYPositionArray[i] = value;
            }
            this.ctx.fillStyle = this.gradient; // set the filllStyle to gradient for a better look
            this.ctx.fillRect(i * 12 /*meterWidth+gap*/ , this.cheight - value + this.capHeight, this.meterWidth, this.cheight); // the meter
        }

        analyser.getFloatTimeDomainData(this.timeDomain);
        this.bars.forEach((bar, i) => {
            let index = Math.floor(i * (this.timeDomain.length / this.bars.length));
            const scaledHeight = (this.timeDomain[index]) * 1e3; // Change 100 to the maximum height you want
            bar.style.height = `${scaledHeight}%`;
        });
    
        this.startAnimation();
    }


}

let playlist = new Playlist(
  [0, 'Mia & Sebastian\'s Theme - Arr. Mercuzio', `music/Mia & Sebastian's Theme - Arr. Mercuzio.mp3`],
);

let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let audioPlayer = new AudioPlayer(audioContext);
let animationUI = new AnimationUI();

let speedFactor = 0.0;
let pitchFactor = 0.0;

let playerEngine, phaseVocoderNode, equalizer, analyser, pitchFactorParam;

async function loadSong(initial){
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
    animationUI.stopAnimation();
    
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

    animationUI.startAnimation();

    if (!initial) 
        audioPlayer.play();

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

document.addEventListener('keydown', (event) => {
    const keyName = event.key;

    if (keyName === 'ArrowRight') {
        playlist.nextSong();
        loadSong(false);
    } else if (keyName === 'ArrowLeft') {
        playlist.previousSong();
        loadSong(false);
    } else if (keyName === 'r') {
        let id = playlist.currentSong.id;
        window.repeatSong(id);
    } else if (keyName === 'p') {
        if (audioPlayer.audioElement.paused) {
            audioPlayer.play();
        } else {
            audioPlayer.pause();
        }
    } else if (keyName === 'f') {
        document.querySelector('input[type="file"]').click();
    }
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
          elementDiv.css("background-color", "#FF0099");
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
    $('.sound-wave').append(
        Array.from({length: 100}, () => $('<div>').addClass('bar'))
    );
    animationUI.bars = document.querySelectorAll('.bar');
    await loadSong(true); // load first song

}