const musicContainer = document.getElementById('music-container');
const playBtn = document.getElementById('play');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');

const audio = document.getElementById('audio');
const progress = document.getElementById('progress');
const progressContainer = document.getElementById('progress-container');
const title = document.getElementById('title');
const cover = document.getElementById('cover');
// const currTime = document.querySelector('#currTime');
// const durTime = document.querySelector('#durTime');
//https://codepen.io/tiger2380/pen/yOvvWo
//http-server /Users/kennethtrinh/Desktop/Music-Player -c-1
//https://github.com/olvb/phaze/blob/master/www/main.js --> TODO


function Song(id, name, path) {
  this.id = id;
  this.name = name;
  this.path = path;
}

var playlist = [
    new Song(0, 'Halsey - Without Me', `music/Halsey - Without Me.mp3`),
    new Song(1, 'Taylor Swift - Red', `music/Taylor Swift - Red.mp3`),
    new Song(2, 'The Chainsmokers, Bebe Rexha - Call You Mine', `music/The Chainsmokers, Bebe Rexha - Call You Mine.mp3`)
];

let songIndex = 2;



var player, pitchShift, loop;
var pitch = 0;
var FFTData = new Tone.FFT(1024);
function init(){
    for (var i=0; i<playlist.length; i++)
        $('.playlist').append(`<div class=playlist-row id=${playlist[i].id} onclick="nav(this.id)"> ${playlist[i].name} </div>`);

    title.innerText = playlist[songIndex].name;
    player = new Tone.Player(playlist[songIndex].path).sync().start(0);
    // player.sync().start(0);
    //polled every second -> updates progress bar and goes to next song when finished
    loop = new Tone.Loop( (time) => {
        const progressPercent = Tone.Transport.seconds / player.buffer._buffer.duration;
        progress.style.width = `${progressPercent*100}%`;
        if (progressPercent > 1)
            nextSong();
        // console.log(FFTData.getValue());
        draw(FFTData.getValue());
        }, 0.1).start(0);
}
init();
// Update song details
function loadSong() {
  title.innerText = playlist[songIndex].name;
  // audio.src = `music/${song}.mp3`;
  // player.load(`music/${song}.mp3`);
  var wasPlaying = player.state == "started";
  Tone.Transport.stop();
  player.load(playlist[songIndex].path).then(
      (value) => {  if (wasPlaying) playSong(); else pauseSong(); },
      (error) => { console.log("error"); }
  );

  cover.src = `images/${playlist[songIndex].name}.jpg`;

}

// Play song
function playSong() {
  musicContainer.classList.add('play');
  playBtn.querySelector('i.fas').classList.remove('fa-play');
  playBtn.querySelector('i.fas').classList.add('fa-pause');
  Tone.Transport.start();// audio.play();
}

// Pause song
function pauseSong() {
  musicContainer.classList.remove('play');
  playBtn.querySelector('i.fas').classList.add('fa-play');
  playBtn.querySelector('i.fas').classList.remove('fa-pause');
  Tone.Transport.pause();// audio.pause();
}

function prevSong() {
  songIndex--;
  if (songIndex < 0)
    songIndex = playlist.length - 1;

  loadSong();
}

function nextSong() {
  songIndex = (songIndex + 1) % playlist.length;
  loadSong();
}

function nav(id){
    songIndex = id;
    loadSong();
}


// Set progress bar
function setProgress(e) {
  const width = this.clientWidth;
  const clickX = e.offsetX;
  const duration = player.buffer._buffer.duration; //audio.duration;
  Tone.Transport.position = (clickX / width) * duration;
}


// Event listeners
playBtn.addEventListener('click', () => {
  // const isPlaying = musicContainer.classList.contains('play');
  pitchShift = new Tone.PitchShift(pitch);
  player.disconnect();
  player.chain(pitchShift, FFTData, Tone.Master);

  if (player.state == "started") {
    pauseSong();
  } else if (player.state == "stopped")  {
    playSong();
  }
});

// Change song
prevBtn.addEventListener('click', prevSong);
nextBtn.addEventListener('click', nextSong);

// Click on progress bar
progressContainer.addEventListener('click', setProgress);

var slider = document.getElementById("myRange");
var output = document.getElementById("demo");
output.innerHTML = slider.value; // Display the default slider value

// Update the current slider value (each time you drag the slider handle)
slider.oninput = function() {
  output.innerHTML = this.value;
  pitchShift.pitch=this.value;
  pitch=this.value;
}


var canvas = document.getElementById('fft'),
          ctx = canvas.getContext('2d');

function draw(data){
    // console.log(data);
    ctx.clearRect(0,0, canvas.width, canvas.height);
    for (var i =0; i < data.length; i++){
        ctx.fillStyle = 'purple';
        // ctx.fillRect(10,10,50,20);
        ctx.fillRect(i, canvas.height, 1, -50000* Math.pow(10, data[data.length-i-1]/20) );

    }
}




// const test = document.getElementById('button');
// var player = new Tone.Player("music/Polo G – I Know.mp3").toDestination(), pitchShift;
// var pitch = 0;
// player.sync().start(0);
// var loop = new Tone.Loop( (time) => {
//     const progressPercent = Tone.Transport.seconds / player.buffer._buffer.duration;
//     console.log( progressPercent );
//     progress.style.width = `${progressPercent}%`;
// }, 0.1).start(0);

// var PAUSED = true;
// function playNote() {
//     PAUSED = !PAUSED;
//     // const synth = new Tone.Synth().toDestination();
//     // synth.triggerAttackRelease("C4", "8n");
//     pitchShift = new Tone.PitchShift(pitch).toDestination();
//     player.disconnect();
//     player.connect(pitchShift);
//     if (player.state == "started") {
//         // Use the Tone.Transport to pause audio
//         Tone.Transport.pause();
//     } else if (player.state == "stopped") {
//         // Use the Tone.Transport to start again
//         Tone.Transport.start();
//     }
//     // console.log(Tone.Transport.immediate());
//     // console.log(Tone.Transport.seconds);
//     // console.log(player.buffer._buffer.duration) ;
//
// }
// test.addEventListener('click', playNote)

// const test2 = document.getElementById('button2');
// test2.addEventListener('click', () => {
//     // Tone.Transport.position=120;
//     Tone.Transport.stop();
//     player.load("music/Juice WRLD Ft Benny Blanco - Real Shit.mp3");
//     // player.sync().start(0);
//     // Tone.Transport.start();
// })
// const elAudio = document.createElement("audio");
// window.document.body.appendChild(elAudio);
// // var audioCtx = new (window.AudioContext || window.webkitAudioContext);
// // var stream = audioCtx.createMediaElementSource(elAudio);
// const mediaElementSource = Tone.context.createMediaElementSource(elAudio);
// Tone.connect(mediaElementSource, player);
//
// // stream.connect(player);
// elAudio.onplay = function() {
//     alert("The audio has started to play");
// };
//
// elAudio.addEventListener('timeupdate', (event) => {
//   console.log(Tone.Transport.seconds);
// });
// document.getElementById("__drop").style.display = "none";
var audioContext = new AudioContext();
function initAudio(data) {
    var audioRequest = new XMLHttpRequest();
    var dfd = jQuery.Deferred();

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

$(document).on('dragover', function(){
    console.log('dragover');
  $('#__drop').removeClass('hidden').addClass('show');
  return false;
});

var buff;
$(document).on('drop', function(e){
  e.stopPropagation();
  e.preventDefault();
  data = e.originalEvent.dataTransfer;
  file = data.files[0];
  var file_name = file.name.substring(0, file.name.length - 4);

  $.when(initAudio(data)).done(function (b) {
      buff=b;

      $('.playlist').append(`<div class=playlist-row id=${playlist.length} onclick="nav(this.id)"> ${file_name} </div>`);
      playlist.push(new Song(playlist.length, file_name, URL.createObjectURL(file)));
      // player.load(URL.createObjectURL(file)).then(
      //     (value) => {console.log('success'); },
      //     (error) => { console.log("error"); }
      // );
      // clearCanvas();
      // setupBars(b);
      // $('#music_title').html(file_name);
      //     $('#audio')[0].src = URL.createObjectURL(file);
  });

  $('#__drop').removeClass('show').addClass('hidden');
});

$('#__drop .show').on('dragleave', function(){
    console.log('dragleave');
  $('#__drop').removeClass('show').addClass('hidden');
});





/*
(function (c, cx) {


    oAudio = document.getElementById('audio');
    oAudio.addEventListener("timeupdate", progressBar, true);

    window.WAVEFORM = WAVEFORM = function (cx, x, y, w, h, speed) {
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
		this.ctx = cx;

		this.trigger = false;
		this.alpha = 0;
		this.speed = speed;
		this.done = false;
    }

    WAVEFORM.prototype = {
      redraw: function(){
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
        this.ctx.restore();
      },
      isPointBar: function(x, y){
        return (x >= (this.x * 3) && x <= (this.x * 3) + this.w);
      },
      highlight: function(){
        var c3 = document.getElementById('view3');
        var _ctx = c3.getContext('2d');
        _ctx.setTransform(1, 0, 0, 1, 0, 0);
        _ctx.clearRect(0,0, c.width, c.height);
        this.fillBars();
      },
      fillBars: function(){
        var barX = (this.x * 3) + this.w;
        var c3 = document.getElementById('view3');
        var _ctx = c3.getContext('2d');

        for(var i = 0; i < barX/3; i++) {
          _ctx.translate(0, c.height / 2);
          _ctx.scale(1, -1);
          _ctx.fillStyle = "#ff894d";//"#FF5600";
          _ctx.fillRect(waveforms[i].x * 3, waveforms[i].y, waveforms[i].w, waveforms[i].h);
          _ctx.setTransform(1, 0, 0, 1, 0, 0);
          _ctx.fillStyle = "#f8e5d9";//"#F0C7AE";
          _ctx.fillRect(waveforms[i].x * 3, c.height / 2 + 11, waveforms[i].w, waveforms[i].h / 2);
        }
      },
		displayBar : function (x) {
			var _this = this;
			var speed = this.speed;
			_this.ctx.save();
			var fadeIn = function(){
				_this.ctx.translate(0, c.height / 2);
				_this.ctx.scale(1, -1);
				_this.ctx.fillStyle = "rgba(255, 86, 0, "+ speed +")";//"#FF5600";
				_this.ctx.fillRect(_this.x * 3, _this.y, _this.w, _this.h);
				_this.ctx.setTransform(1, 0, 0, 1, 0, 0);
				_this.ctx.fillStyle = "rgba(240, 199, 174, "+ speed +")";//"#F0C7AE";
				_this.ctx.fillRect(_this.x * 3, c.height / 2 + 11, _this.w, _this.h / 2);

				speed += speed;

				var fade = requestAnimationFrame(fadeIn);

				if(speed > 1) {
					cancelAnimationFrame(fade);
				}
			}

			fadeIn();
		},
		trigger: function(){
			this.trigger.true;
		}
	}
    var j = 0;
    function progressBar() {
        var oAudio = document.getElementById('audio');
        var elapsedTime = Math.round(oAudio.currentTime);
        var fWidth = Math.floor((elapsedTime / oAudio.duration) * (c.width));
        var p = Math.ceil(fWidth/3);

        if (!oAudio.paused && p > 0) {
			for(j = 0; j < p; j++) {
				if (typeof waveforms[j] != 'undefined') {
					waveforms[j].displayBar();
				}
			}
			j = Math.max(j + 1, p + 1);
        }
    }

    var setupBars = function (b) {
        var data = b.getChannelData(0);
        var step = Math.ceil(data.length / c.width);
        var amp = (c.height / 2);
        var oAudio = document.getElementById('audio');
        var c2 = document.getElementById('view2');
        var ctx = c2.getContext('2d');

        for (var i = 0; i < c.width; i++) {
            var min = 1.0;
            var max = -1.0;

            for (var j = 0; j < step; j++) {
                var datum = data[(i * step * 3) + j];
                if (datum > max)
                    max = datum;
            }

            cx.translate(0, c.height / 2);
            cx.scale(1, -1);

            cx.fillStyle = "#E5E5E5";
            cx.fillRect(i * 3, -10, 2, max * amp);
            cx.setTransform(1, 0, 0, 1, 0, 0);
            cx.fillStyle = "#9DA09B";
            cx.fillRect(i * 3, c.height / 2 + 12, 2, max * amp / 2);

            window.waveforms[i] = waveforms[i] = new WAVEFORM(ctx, i, -10, 2, max * amp, 0.02);
        }
    }
}(document.getElementById('view1'), document.getElementById('view1').getContext('2d')));
*/
