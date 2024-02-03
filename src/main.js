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

let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let audioPlayer = new AudioPlayer(audioContext);

let speedFactor = 0.0;
let pitchFactor = 0.0;

function Song(id, name, path) {
  this.id = id;
  this.name = name;
  this.path = path;
}

let playlist = [
    new Song(0, 'Mia & Sebastian\'s Theme - Arr. Mercuzio', `music/Mia & Sebastian's Theme - Arr. Mercuzio.mp3`),

];

let songIndex = 0;
let playerEngine, phaseVocoderNode, equalizer, analyser, pitchFactorParam;

async function init() {
    let Playlist= document.getElementsByClassName('playlist')[0];
    for (let i=0; i<playlist.length; i++){
        let div2 = document.createElement('div');
        div2.className = 'playlist-row';
        div2.id = playlist[i].id;
        div2.onclick = async function () {
                        songIndex = this.id;
                        await loadSong(false);
                        };
        div2.innerHTML = playlist[i].name;
        Playlist.appendChild(div2);
    }
    await loadSong(true);

}

async function loadSong(initial){
    $forwardButton.classList.add('disabled');
    $backwardButton.classList.add('disabled');
    $("h1").text( playlist[songIndex].name )
    if (audioContext.audioWorklet === undefined) {
        let $noWorklet = document.querySelector("#no-worklet");
        $noWorklet.style.display = 'block';
        let $controls = document.querySelector(".controls");
        $controls.style.display = 'none';
        return;
    }
    // let wasPlaying = !initial && !audioPlayer.audioElement.paused;

    stopAnimation(); 

    let oldEqualizer = initial ? null : equalizer.getGains();
    if (window.performance && performance.memory) {
        console.log(`Total Memory: ${performance.memory.totalJSHeapSize / (1024 * 1024)} MB`, '\n',
                    `Used Memory: ${performance.memory.usedJSHeapSize / (1024 * 1024)} MB`, '\n',
                    `Limit: ${performance.memory.jsHeapSizeLimit / (1024 * 1024)} MB`);
    }

    audioPlayer.loadSong(playlist[songIndex].path);
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

    await audioContext.audioWorklet.addModule('phase-vocoder.js');
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
    songIndex = (songIndex + 1) % playlist.length;
    loadSong(false);

});

$backwardButton.addEventListener('click', async ()=>{
    songIndex--;
    if (songIndex < 0)
      songIndex = playlist.length - 1;
    loadSong(false);
});



let audioElement = audioPlayer.audioElement;
audioElement.addEventListener('play', function() {
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
  });

audioElement.addEventListener('ended', function() {
    songIndex = (songIndex + 1) % playlist.length;
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
                `<div class=playlist-row id=${playlist.length} onclick="nav(this.id)"> ${file_name} </div>`
            );
            playlist.push(new Song(playlist.length, file_name, URL.createObjectURL(file)));
        });
    }
}

window.nav = function (id){
    songIndex = id;
    loadSong(false);
}

window.addEventListener('load', init);