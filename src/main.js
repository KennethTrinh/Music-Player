const wavesAudio = require('waves-audio');
const wavesUI = require('waves-ui');
const wavesLoaders = require('waves-loaders');

let audioContext = wavesAudio.audioContext;
let loader = new wavesLoaders.AudioBufferLoader();

let speedFactor = 1.0;
let pitchFactor = 1.0;

function Song(id, name, path) {
  this.id = id;
  this.name = name;
  this.path = path;
}

let playlist = [
    new Song(0, 'Mia & Sebastian\'s Theme - Arr. Mercuzio', `music/Mia & Sebastian's Theme - Arr. Mercuzio.mp3`),

];

let songIndex = 0;
let playControl, buffer, playerEngine, phaseVocoderNode,
analyser, timeline, pitchFactorParam;

async function init() {
    let Playlist= document.getElementsByClassName('playlist')[0];
    for (let i=0; i<playlist.length; i++){
        let div2 = document.createElement('div');
        div2.className = 'playlist-row';
        div2.id = playlist[i].id;
        div2.onclick = async function () {
                        songIndex = this.id;
                        [buffer, playControl, playerEngine, phaseVocoderNode, analyser] = await loadSong(false);
                        };
        div2.innerHTML = playlist[i].name;
        Playlist.appendChild(div2);
    }
    let [buffer, playControl, playerEngine, phaseVocoderNode, analyser] = await loadSong(true);

}

async function loadSong(initial){
    $playButton.classList.add('disabled');
    $forwardButton.classList.add('disabled');
    $backwardButton.classList.add('disabled');
    $("h1").text( playlist[songIndex].name )
    if (audioContext.audioWorklet === undefined) {
        handleNoWorklet();
        return;
    }
    let wasPlaying = $playButton.dataset.playing;
    if (playControl)
        playControl.stop();

    stop(); //stop the previous animation loop

    //load the audio
    buffer = await loader.load( playlist[songIndex].path );
    [playerEngine, phaseVocoderNode, analyser] = await setupEngine(buffer);
    playControl = new wavesAudio.PlayControl(playerEngine);
    playControl.setLoopBoundaries(0, buffer.duration);
    playControl.loop = false;

    //setting up pitch slider
    let oldPitch, oldSpeed;
    if (!initial){
        oldPitch = $pitchvalueLabel.innerHTML
        oldSpeed = $valueLabel.innerHTML;
    }
    pitchFactorParam = phaseVocoderNode.parameters.get('pitchFactor');
    if (!initial){
        playControl.speed = Math.pow(2, parseFloat(oldSpeed)/12);
        pitchFactorParam.value = Math.pow(2, parseFloat(oldPitch - oldSpeed)/12);
    }

    //setup timeline
    if (initial)
        setupTimeline(buffer);
    else
        updateTimeline(buffer);

    if (wasPlaying == 'true')
        playControl.start();

    $playButton.classList.remove('disabled');
    $forwardButton.classList.remove('disabled');
    $backwardButton.classList.remove('disabled');

    return [buffer, playControl, playerEngine, phaseVocoderNode, analyser];
}

function handleNoWorklet() {
    let $noWorklet = document.querySelector("#no-worklet");
    $noWorklet.style.display = 'block';
    let $timeline = document.querySelector(".timeline");
    $timeline.style.display = 'none';
    let $controls = document.querySelector(".controls");
    $controls.style.display = 'none';
}

async function setupEngine(buffer) {
    playerEngine = new wavesAudio.PlayerEngine(buffer);
    playerEngine.buffer = buffer;
    playerEngine.cyclic = false;

    await audioContext.audioWorklet.addModule('phase-vocoder.js');
    phaseVocoderNode = new AudioWorkletNode(audioContext, 'phase-vocoder-processor', { outputChannelCount: [2] });
    analyser = audioContext.createAnalyser();
    playerEngine.connect(phaseVocoderNode);
    phaseVocoderNode.connect(analyser);
    analyser.connect(audioContext.destination);

    return [playerEngine, phaseVocoderNode, analyser];
}


let $forwardButton = document.querySelector('#forward');
let $backwardButton = document.querySelector('#backward');
let $playButton = document.querySelector('#play-pause');

$forwardButton.addEventListener('click', async ()=>{
    songIndex = (songIndex + 1) % playlist.length;
    [buffer, playControl, playerEngine, phaseVocoderNode, analyser] = await loadSong(false);

});

$backwardButton.addEventListener('click', async ()=>{
    songIndex--;
    if (songIndex < 0)
      songIndex = playlist.length - 1;
    [buffer, playControl, playerEngine, phaseVocoderNode, analyser] = await loadSong(false);
});




let $playIcon = $playButton.querySelector('.play');
let $pauseIcon = $playButton.querySelector('.pause');
$playButton.addEventListener('click', function() {
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
    if (this.dataset.playing === 'false') {
        playControl.start();
        this.dataset.playing = 'true';
        $playIcon.style.display = 'none';
        $pauseIcon.style.display = 'inline';
    } else if (this.dataset.playing === 'true') {
        playControl.pause();
        this.dataset.playing = 'false';
        $pauseIcon.style.display = 'none';
        $playIcon.style.display = 'inline';
    }
}, false);



let $speedSlider = document.querySelector('#speed');
let $valueLabel = document.querySelector('#speed-value');
$speedSlider.addEventListener('input', function() {
    speedFactor = Math.pow(2, parseFloat(this.value)/12);
    playControl.speed = speedFactor;
    pitchFactorParam.value = pitchFactor * 1 / speedFactor;
    $valueLabel.innerHTML = this.value;
}, false);


let $pitchSlider = document.querySelector('#pitch');
let $pitchvalueLabel = document.querySelector('#pitch-value');
$pitchSlider.addEventListener('input', function() {
    pitchFactor = Math.pow(2, parseFloat(this.value)/12);
    pitchFactorParam.value = pitchFactor * 1 / speedFactor;
    $pitchvalueLabel.innerHTML = this.value;
}, false);


let duration;
const height = 200;

let $timeline = document.querySelector('#timeline');
let width = $timeline.getBoundingClientRect().width;

$timeline.addEventListener('mousedown', (e) => {
    let rect = $timeline.getBoundingClientRect()
    let x = e.clientX - rect.left
    let y = e.clientY - rect.top
    // console.log("x: " + x + " y: " + y);
    playControl.seek(x / width * duration);
}, false);



let cursorData = { position: 0 };
let cursorLayer = new wavesUI.core.Layer('entity', cursorData, {
  height: height
});
let waveformLayer, timeContext;

let requestId;
// cursor animation loop
async function loop() {
    requestId = undefined;
    cursorData.position = playControl.currentPosition;
    timeline.tracks.update(cursorLayer);

    // console.log(playControl.currentPosition );
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
    if(playControl.currentPosition > buffer.duration){ // if song ended
        songIndex = (songIndex + 1) % playlist.length;
        [buffer, playControl, playerEngine, phaseVocoderNode, analyser] = await loadSong(false);
    }

    start();
}

function start(){
    if (!requestId)
        requestId = requestAnimationFrame(loop);
}
function stop() {
    if (requestId) {
       cancelAnimationFrame(requestId);
       requestId = undefined;
    }
}

function setupTimeline(buffer) {

    duration = buffer.duration;
    const pixelsPerSecond = width / duration;

    timeline = new wavesUI.core.Timeline(pixelsPerSecond, width);
    timeline.createTrack($timeline, height, 'main');

     waveformLayer = new wavesUI.helpers.WaveformLayer(buffer, {
        height: height
    });

     timeContext = new wavesUI.core.LayerTimeContext(timeline.timeContext);
    cursorLayer.setTimeContext(timeContext);
    cursorLayer.configureShape(wavesUI.shapes.Cursor, {
        x: (data) => { return data.position; }
    }, {
        color: 'deeppink'
    });

    timeline.addLayer(waveformLayer, 'main');
    timeline.addLayer(cursorLayer, 'main');

    timeline.tracks.render();
    timeline.tracks.update();

    start()
}

function updateTimeline(buffer) {
    // timeline.remove($timeline);
    timeline.removeLayer(waveformLayer);
    timeline.removeLayer(cursorLayer);
    duration = buffer.duration;
    timeline.pixelsPerSecond = width / duration;

     waveformLayer = new wavesUI.helpers.WaveformLayer(buffer, {
        height: height
    });

    timeContext = new wavesUI.core.LayerTimeContext(timeline.timeContext);
    cursorLayer.setTimeContext(timeContext);
    cursorLayer.configureShape(wavesUI.shapes.Cursor, {
        x: (data) => { return data.position; }
    }, {
        color: 'deeppink'
    });

    timeline.addLayer(waveformLayer, 'main');
    timeline.addLayer(cursorLayer, 'main');

    timeline.tracks.render();
    timeline.tracks.update();
    start()
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