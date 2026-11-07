import EqualizerNode from "./equalizer.js";
import { detectKey, keyFullName, keyLabel } from "./key-detect.js";

/**
 * Plays a decoded AudioBuffer. Speed is the source node's playbackRate, so the pitch moves with it and the
 * vocoder cancels that. This replaces an <audio> element feeding createMediaElementSource, which stalls the
 * audio thread at non-1x rates on iOS Safari. Exposes the bits of the media element API the UI uses: paused,
 * currentTime, duration, volume and the play / pause / ended / loadedmetadata / timeupdate events.
 */
class AudioPlayer extends EventTarget {
    constructor(audioContext) {
        super();
        this.audioContext = audioContext;
        // a stable output node, so the rest of the graph never sees the per-play source nodes
        this.sourceNode = audioContext.createGain();
        this.buffer = null;
        this.source = null;
        this.paused = true;
        this.rate = 1;
        this.offset = 0; // song position (s) at the last anchor
        this.startedAt = 0; // context time of the last anchor
        this.loadToken = 0;
        this.ticker = null;
        // play through the iOS silent switch, like a media element does
        if (navigator.audioSession) navigator.audioSession.type = "playback";
    }

    emit(type) {
        this.dispatchEvent(new Event(type));
    }

    async loadSong(url) {
        const token = ++this.loadToken;
        this.stopSource();
        this.stopTicker();
        const wasPlaying = !this.paused;
        this.paused = true;
        this.buffer = null; // release the previous song's samples before decoding the next
        this.offset = 0;
        if (wasPlaying) this.emit("pause");

        const data = await (await fetch(url)).arrayBuffer();
        const buffer = await this.audioContext.decodeAudioData(data);
        if (token !== this.loadToken) return; // a newer load superseded this one
        this.buffer = buffer;
        this.emit("loadedmetadata");
        this.emit("timeupdate");
    }

    get duration() {
        return this.buffer ? this.buffer.duration : NaN;
    }

    get currentTime() {
        if (!this.buffer) return 0;
        if (this.paused) return this.offset;
        const elapsed = (this.audioContext.currentTime - this.startedAt) * this.rate;
        return Math.min(this.buffer.duration, this.offset + elapsed);
    }

    set volume(value) {
        this.sourceNode.gain.value = value;
    }

    startSource() {
        const source = this.audioContext.createBufferSource();
        source.buffer = this.buffer;
        source.playbackRate.value = this.rate;
        source.connect(this.sourceNode);
        source.onended = () => {
            if (this.source !== source) return; // stopped by us (pause, seek, new song), not the end of the song
            this.source = null;
            this.paused = true;
            this.offset = this.buffer.duration;
            this.stopTicker();
            this.emit("timeupdate");
            this.emit("ended");
        };
        this.source = source;
        this.startedAt = this.audioContext.currentTime;
        source.start(0, this.offset);
    }

    stopSource() {
        const source = this.source;
        if (!source) return;
        this.source = null; // detach first so onended knows this was deliberate
        source.stop();
        source.disconnect();
    }

    startTicker() {
        this.stopTicker();
        this.ticker = setInterval(() => this.emit("timeupdate"), 250);
    }

    stopTicker() {
        clearInterval(this.ticker);
        this.ticker = null;
    }

    play() {
        if (!this.buffer || !this.paused) return;
        if (this.offset >= this.buffer.duration) this.offset = 0;
        if (this.audioContext.state === "suspended") this.audioContext.resume();
        this.paused = false;
        this.startSource();
        this.startTicker();
        this.emit("play");
    }

    pause() {
        if (!this.buffer || this.paused) return;
        this.offset = this.currentTime;
        this.stopSource();
        this.stopTicker();
        this.paused = true;
        this.emit("pause");
        this.emit("timeupdate");
    }

    seek(timeInSeconds) {
        if (!this.buffer) return;
        const target = Math.max(0, Math.min(timeInSeconds, this.buffer.duration));
        this.offset = target;
        if (!this.paused) {
            this.stopSource();
            this.startSource();
        }
        this.emit("timeupdate");
    }

    get playbackRate() {
        return this.rate;
    }

    set playbackRate(rate) {
        // re-anchor so currentTime stays continuous across the change
        this.offset = this.currentTime;
        this.startedAt = this.audioContext.currentTime;
        this.rate = rate;
        if (this.source) this.source.playbackRate.value = rate;
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
    constructor(id, name, path, artwork = null) {
        this.id = id;
        this.name = name;
        this.path = path;
        this.artwork = artwork;
        this.key = null; // detected { tonic, isMinor }, filled in later; never persisted
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

    addSong(id, name, path, artwork = null) {
        this.songs.push(new Song(id, name, path, artwork));
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
        if (this.repeatSongIndex !== null) this.songIndex = this.repeatSongIndex - 1;

        this.songIndex = (this.songIndex + 1) % this.songs.length;
        return this.currentSong;
    }

    previousSong() {
        if (this.repeatSongIndex !== null) this.songIndex = this.repeatSongIndex + 1;

        this.songIndex--;
        if (this.songIndex < 0) this.songIndex = this.songs.length - 1;
        return this.currentSong;
    }

    deleteSong(songIndex) {
        if (songIndex < 0 || songIndex >= this.length) {
            throw new Error("Invalid song index");
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
        });
    }
}

// Waveform strip: bar height is the sample value in percent of the strip (WAVE_GAIN % per unit amplitude),
// capped at 100% so loud passages stay inside the card.
const WAVE_GAIN = 1000;
const WAVE_MAX_HEIGHT = 100; // percent

class AnimationUI {
    constructor() {
        this.requestId = undefined;
        window.addEventListener("resize", this.canvasFreqUpdate.bind(this));
        this.canvasFreqUpdate();

        // time domain
        this.bars = document.querySelectorAll(".bar");
        this.timeDomain = new Float32Array(1024);
        this.loop = this.loop.bind(this);
    }
    canvasFreqUpdate() {
        this.canvas = document.getElementById("canvas");
        this.canvas.width = window.innerWidth * (window.innerWidth < 768 ? 0.9 : 0.6);
        this.canvas.height = window.innerHeight * 0.3;
        this.cwidth = this.canvas.width;
        this.cheight = this.canvas.height - 2;
        this.meterNum = 80;
        this.meterWidth = this.cwidth / (this.meterNum + this.canvas.width * 0.01);
        this.capHeight = 3;
        this.capStyle = "#fff";
        this.capYPositionArray = []; // store the vertical position of hte caps for the preivous frame
        this.ctx = this.canvas.getContext("2d");
        this.gradient = this.ctx.createLinearGradient(0, 0, 0, 300);
        this.gradient.addColorStop(1, "#FF0099");
        this.gradient.addColorStop(0.5, "#FF00FF");
        this.gradient.addColorStop(0, "#FF99FF");
        this.frequncyDomain = new Uint8Array(1024);
    }

    startAnimation() {
        if (!this.requestId) this.requestId = requestAnimationFrame(this.loop);
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
            let value = this.frequncyDomain[i * step] * (this.cheight * 0.004);
            if (this.capYPositionArray.length < Math.round(this.meterNum)) {
                this.capYPositionArray.push(value);
            }
            this.ctx.fillStyle = this.capStyle;
            // draw the cap, with transition effect
            if (value < this.capYPositionArray[i]) {
                this.ctx.fillRect(
                    i * 12,
                    this.cheight - --this.capYPositionArray[i],
                    this.meterWidth,
                    this.capHeight,
                );
            } else {
                this.ctx.fillRect(i * 12, this.cheight - value, this.meterWidth, this.capHeight);
                this.capYPositionArray[i] = value;
            }
            this.ctx.fillStyle = this.gradient; // set the filllStyle to gradient for a better look
            this.ctx.fillRect(
                i * 12 /*meterWidth+gap*/,
                this.cheight - value + this.capHeight,
                this.meterWidth,
                this.cheight,
            ); // the meter
        }

        analyser.getFloatTimeDomainData(this.timeDomain);
        this.bars.forEach((bar, i) => {
            let index = Math.floor(i * (this.timeDomain.length / this.bars.length));
            const sample = this.timeDomain[index];
            // only the positive half of the wave is drawn; a negative sample leaves the bar where it was
            if (sample > 0) {
                bar.style.height = `${Math.min(WAVE_MAX_HEIGHT, sample * WAVE_GAIN)}%`;
            }
        });

        this.startAnimation();
    }
}

let playlist = new Playlist();

let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let audioPlayer = new AudioPlayer(audioContext);
let animationUI = new AnimationUI();

let speedFactor = 0.0;
let pitchFactor = 0.0;

let playerEngine, phaseVocoderNode, equalizer, analyser, pitchFactorParam;

// Pitch-shift algorithms, each an AudioWorklet registering a processor with a `pitchFactor` param
const ALGORITHMS = {
    classic: { module: "./dist/phase-vocoder.js", processor: "phase-vocoder-processor" },
    pghi: { module: "./dist/pghi-vocoder.js", processor: "pghi-processor" },
};

async function createVocoderNode() {
    const algorithm = ALGORITHMS[document.querySelector("#algorithm-select").value];
    await audioContext.audioWorklet.addModule(algorithm.module);
    return new AudioWorkletNode(audioContext, algorithm.processor, {
        outputChannelCount: [2],
    });
}

// Speed resamples the audio (pitch moves with it), so the vocoder shifts by pitch / speed
function applyPitch(semitones) {
    pitchFactorParam.value = Math.pow(2, semitones / 12) / audioPlayer.playbackRate;
}

// Switch algorithm mid-song: replace the worklet node in the graph, keeping the pitch setting
async function swapAlgorithm() {
    if (!phaseVocoderNode) return;
    const oldNode = phaseVocoderNode;
    const pitch = pitchFactorParam.value;
    const newNode = await createVocoderNode();
    playerEngine.disconnect(oldNode);
    oldNode.disconnect();
    playerEngine.connect(newNode);
    newNode.connect(equalizer);
    phaseVocoderNode = newNode;
    pitchFactorParam = newNode.parameters.get("pitchFactor");
    pitchFactorParam.value = pitch;
}

// Loads can't overlap: each one rebuilds the audio graph and reads the previous load's equalizer. Taps that arrive
// during a load collapse into a single reload of whatever song is current once it finishes.
let loading = false;
let reloadRequested = false;
async function loadSong(initial) {
    if (loading) {
        reloadRequested = true;
        return;
    }
    loading = true;
    try {
        await loadSongNow(initial);
        while (reloadRequested) {
            reloadRequested = false;
            await loadSongNow(false);
        }
    } finally {
        loading = false;
        reloadRequested = false; // don't carry a request over if a load threw
    }
}

async function loadSongNow(initial) {
    if (audioContext.audioWorklet === undefined) {
        let $noWorklet = document.querySelector("#no-worklet");
        $noWorklet.style.display = "block";
        let $controls = document.querySelector(".controls");
        $controls.style.display = "none";
        return;
    }
    if (playlist.songs.length === 0) {
        return;
    }
    $("h1").text(playlist.currentSong.name);
    updateNowPlayingArt(playlist.currentSong.artwork);
    updatePitchKey();

    // Highlight the current song
    $(".playlist-row").removeClass("active");
    $(`#${playlist.songIndex}`).addClass("active");
    animationUI.stopAnimation();

    let oldEqualizer = initial ? null : equalizer.getGains();
    if (window.performance && performance.memory) {
        console.log(
            `Total Memory: ${performance.memory.totalJSHeapSize / (1024 * 1024)} MB`,
            "\n",
            `Used Memory: ${performance.memory.usedJSHeapSize / (1024 * 1024)} MB`,
            "\n",
            `Limit: ${performance.memory.jsHeapSizeLimit / (1024 * 1024)} MB`,
        );
    }

    await Promise.all([audioPlayer.loadSong(playlist.currentSong.path), setupEngine(initial)]);

    //setting up pitch slider
    pitchFactorParam = phaseVocoderNode.parameters.get("pitchFactor");
    if (!initial) {
        let oldPitch = $pitchvalueLabel.innerHTML;
        let oldSpeed = $valueLabel.innerHTML;
        audioPlayer.playbackRate = Math.pow(2, parseFloat(oldSpeed) / 12);
        applyPitch(parseFloat(oldPitch));
        equalizer.setGains(oldEqualizer);
    }

    animationUI.startAnimation();

    if (!initial) audioPlayer.play();
}

function updateNowPlayingArt(artworkUrl) {
    const art = document.getElementById("np-art");
    if (artworkUrl) {
        art.src = artworkUrl;
        art.hidden = false;
    } else {
        art.removeAttribute("src");
        art.hidden = true;
    }
}

async function setupEngine(initial) {
    if (!initial) {
        playerEngine.disconnect();
        phaseVocoderNode.disconnect();
        equalizer.disconnect();
        analyser.disconnect();
    }
    playerEngine = audioPlayer.node;

    phaseVocoderNode = await createVocoderNode();
    equalizer = new EqualizerNode(audioContext);
    analyser = audioContext.createAnalyser();

    playerEngine.connect(phaseVocoderNode);
    phaseVocoderNode.connect(equalizer);
    equalizer.connect(analyser);
    analyser.connect(audioContext.destination);
}

document.addEventListener("keydown", (event) => {
    const keyName = event.key;

    if (keyName === "ArrowDown" || keyName === "s") {
        event.preventDefault();
        playlist.nextSong();
        loadSong(false);
    } else if (keyName === "ArrowUp" || keyName === "w") {
        event.preventDefault();
        playlist.previousSong();
        loadSong(false);
    } else if (keyName === "ArrowRight") {
        event.preventDefault();
        pitchFactor = parseFloat($pitchvalueLabel.innerHTML) + 1;
        applyPitch(pitchFactor);
        $pitchSlider.value = pitchFactor;
        $pitchvalueLabel.innerHTML = pitchFactor;
        updatePitchKey();
    } else if (keyName === "ArrowLeft") {
        event.preventDefault();
        pitchFactor = parseFloat($pitchvalueLabel.innerHTML) - 1;
        applyPitch(pitchFactor);
        $pitchSlider.value = pitchFactor;
        $pitchvalueLabel.innerHTML = pitchFactor;
        updatePitchKey();
    } else if (keyName === "r") {
        let id = playlist.currentSong.id;
        window.repeatSong(id);
    } else if (keyName === "d") {
        let id = playlist.currentSong.id;
        window.deleteSong(id);
    } else if (keyName === "p") {
        if (audioPlayer.paused) {
            audioPlayer.play();
        } else {
            audioPlayer.pause();
        }
    } else if (keyName === "f") {
        document.querySelector('input[type="file"]').click();
    }
});

audioPlayer.addEventListener("play", function () {
    if (audioContext.state === "suspended") {
        audioContext.resume();
    }
});

audioPlayer.addEventListener("ended", function () {
    playlist.nextSong();
    loadSong(false);
});

// Transport bar
const $playBtn = document.querySelector("#play-btn");
const $seek = document.querySelector("#seek");
const $timeCurrent = document.querySelector("#time-current");
const $timeTotal = document.querySelector("#time-total");

function formatTime(seconds) {
    if (!isFinite(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function syncPlayButton() {
    const paused = audioPlayer.paused;
    $playBtn.innerHTML = paused ? "&#9654;&#xFE0E;" : "&#10074;&#10074;";
    $playBtn.setAttribute("aria-label", paused ? "Play" : "Pause");
}

$playBtn.addEventListener("click", () => {
    if (audioPlayer.paused) audioPlayer.play();
    else audioPlayer.pause();
});
document.querySelector("#next-btn").addEventListener("click", () => {
    playlist.nextSong();
    loadSong(false);
});
document.querySelector("#prev-btn").addEventListener("click", () => {
    playlist.previousSong();
    loadSong(false);
});
audioPlayer.addEventListener("play", syncPlayButton);
audioPlayer.addEventListener("pause", syncPlayButton);
audioPlayer.addEventListener("loadedmetadata", () => {
    $seek.max = audioPlayer.duration;
    $timeTotal.textContent = formatTime(audioPlayer.duration);
});
audioPlayer.addEventListener("timeupdate", () => {
    if (!$seek.matches(":active")) $seek.value = audioPlayer.currentTime;
    $timeCurrent.textContent = formatTime(audioPlayer.currentTime);
});
$seek.addEventListener("input", () => audioPlayer.seek(parseFloat($seek.value)));
document.querySelector("#volume").addEventListener("input", function () {
    audioPlayer.volume = parseFloat(this.value);
});

let $speedSlider = document.querySelector("#speed");
let $valueLabel = document.querySelector("#speed-value");
$speedSlider.addEventListener(
    "input",
    function () {
        speedFactor = Math.pow(2, parseFloat(this.value) / 12);
        // playControl.speed = speedFactor;
        audioPlayer.playbackRate = speedFactor;
        applyPitch(parseFloat($pitchvalueLabel.innerHTML));
        $valueLabel.innerHTML = this.value;
    },
    false,
);

let $pitchSlider = document.querySelector("#pitch");
let $pitchvalueLabel = document.querySelector("#pitch-value");
$pitchSlider.addEventListener(
    "input",
    function () {
        pitchFactor = this.value;
        applyPitch(parseFloat(this.value));
        $pitchvalueLabel.innerHTML = this.value;
        updatePitchKey();
    },
    false,
);

document.querySelector("#algorithm-select").addEventListener("change", swapAlgorithm);

let $equalizer = document.querySelector("#equalizer");
let $equalizerLabel = document.querySelector("#equalizer-value");
let $frequencySelect = document.querySelector("#frequency-select");
$equalizer.addEventListener(
    "input",
    function () {
        let frequency = $frequencySelect.value;
        let gain = this.value;
        equalizer.setGain(parseFloat(frequency), parseFloat(gain));
        $equalizerLabel.innerHTML = this.value;
    },
    false,
);

$frequencySelect.addEventListener(
    "change",
    function () {
        let frequency = this.value;
        let gain = equalizer.getGain(parseFloat(frequency));
        $equalizer.value = gain;
        $equalizerLabel.innerHTML = gain;
    },
    false,
);

// Songs are analysed one at a time so only one decoded buffer is in memory; keys are not stored.
// Key detection is optional: whatever goes wrong in here is logged and the player carries on without a key.
let keyQueue = Promise.resolve();
function queueKey(song, row, getArrayBuffer) {
    keyQueue = keyQueue.then(async () => {
        try {
            const key = await detectKey(await getArrayBuffer());
            if (!key) return;
            song.key = key;
            row.querySelector(".song-key").textContent = keyLabel(key);
            if (playlist.currentSong === song) updatePitchKey();
        } catch (error) {
            console.warn("Key detection failed", error);
        }
    });
}

// The pitch slider shows the detected key moved by the current pitch shift, which is just modular arithmetic.
function updatePitchKey() {
    try {
        const el = document.getElementById("pitch-key");
        const key = playlist.currentSong?.key;
        const shift = parseFloat($pitchvalueLabel.textContent) || 0;
        el.textContent = key ? keyFullName(key, shift) : "";
        el.title = key && shift ? `Original key: ${keyFullName(key)}` : "";
    } catch (error) {
        console.warn("Could not show key", error);
    }
}

window.extract = async (data) => {
    let files = data.files;
    for (let i = 0; i < files.length; i++) {
        let file = files[i];
        let file_name = file.name.split(".").slice(0, -1).join(".");

        // Extract album artwork
        let artworkUrl = null;
        try {
            if (window.parseBlob) {
                const metadata = await window.parseBlob(file);
                if (metadata.common.picture && metadata.common.picture.length > 0) {
                    const pic = metadata.common.picture[0];
                    const blob = new Blob([pic.data], { type: pic.format });
                    artworkUrl = URL.createObjectURL(blob);
                }
            }
        } catch (error) {
            console.warn("Could not extract artwork for", file_name, error);
        }

        const artworkHtml = artworkUrl
            ? `<img class="playlist-artwork" src="${artworkUrl}" alt="Album art">`
            : "";
        $(".playlist").append(
            `<div class=playlist-row id=${playlist.songs.length} onclick="nav(this.id)">
                <span class="repeat-emoji" style="display: none; position: absolute; top: 5px; right: 5px; font-size: 20px;">🔁</span>
                ${artworkHtml}
                <span class="song-name">${file_name}</span>
                <span class="song-key"></span>
                <button class="delete-button" onclick="deleteSong(this.parentElement.id); event.stopPropagation();">Delete</button>
                <button class="repeat-button" onclick="repeatSong(this.parentElement.id); event.stopPropagation();">Repeat</button>
            </div>`,
        );
        playlist.addSong(
            playlist.songs.length,
            file_name,
            URL.createObjectURL(file),
            artworkUrl,
        );
        queueKey(playlist.songs[playlist.songs.length - 1], $(".playlist-row").last()[0], () => file.arrayBuffer());
    }
};

window.nav = function (id) {
    id = parseInt(id);
    playlist.currentSong = id;
    loadSong(false);
};

window.deleteSong = function (id) {
    id = parseInt(id);
    playlist.deleteSong(id);
    $(`#${id}`).remove();
    $(".playlist-row").each(function (index) {
        $(this).attr("id", index);
    });
};

window.repeatSong = function (id) {
    id = parseInt(id);
    let toggleRepeatEmoji = (id, enable) => {
        let emojiElement = $(`#${id} .repeat-emoji`);
        if (enable) {
            emojiElement.show();
        } else {
            emojiElement.hide();
        }
    };

    if (playlist.repeatSong === id) {
        // if repeat is already set, unset it
        toggleRepeatEmoji(id, false);
        playlist.repeatSong = null;
    } else if (playlist.repeatSong !== null) {
        // if another repeat is set, unset it
        toggleRepeatEmoji(playlist.repeatSong, false);
        playlist.repeatSong = id;
        toggleRepeatEmoji(id, true);
    } else {
        // set repeat
        playlist.repeatSong = id;
        toggleRepeatEmoji(id, true);
    }
};

window.onload = async function () {
    const resp = await fetch("music/index.json");
    const songs = await resp.json();

    // Load songs with metadata extraction
    for (let i = 0; i < songs.length; i++) {
        const song = songs[i];
        let artworkUrl = null;

        // Extract album artwork from pre-loaded songs
        try {
            if (window.parseBlob) {
                const audioResp = await fetch(song.path);
                const audioBlob = await audioResp.blob();
                const metadata = await window.parseBlob(audioBlob);

                if (metadata.common.picture && metadata.common.picture.length > 0) {
                    const pic = metadata.common.picture[0];
                    const blob = new Blob([pic.data], { type: pic.format });
                    artworkUrl = URL.createObjectURL(blob);
                }
            }
        } catch (error) {
            console.warn("Could not extract artwork for", song.name, error);
        }

        playlist.addSong(i, song.name, song.path, artworkUrl);

        const artworkHtml = artworkUrl
            ? `<img class="playlist-artwork" src="${artworkUrl}" alt="Album art">`
            : "";
        $(".playlist").append(
            `<div class=playlist-row id=${i} onclick="nav(this.id)">
                <span class="repeat-emoji" style="display: none; position: absolute; top: 5px; right: 5px; font-size: 20px;">🔁</span>
                ${artworkHtml}
                <span class="song-name">${song.name}</span>
                <span class="song-key"></span>
                <button class="delete-button" onclick="deleteSong(this.parentElement.id); event.stopPropagation();">Delete</button>
                <button class="repeat-button" onclick="repeatSong(this.parentElement.id); event.stopPropagation();">Repeat</button>
            </div>`,
        );
        queueKey(playlist.songs[playlist.songs.length - 1], $(".playlist-row").last()[0], async () =>
            (await fetch(song.path)).arrayBuffer(),
        );
    }

    $(".sound-wave").append(Array.from({ length: 100 }, () => $("<div>").addClass("bar")));
    animationUI.bars = document.querySelectorAll(".bar");

    document.querySelector(".playlist-text").addEventListener("click", function () {
        document.querySelector(".playlist-container").classList.toggle("open");
    });

    await loadSong(true); // load first song
};
