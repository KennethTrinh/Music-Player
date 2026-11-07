// Lock screen / control centre integration (Media Session API).
//
// iOS only forwards a page's Media Session commands to the system once a media *element* is the Now Playing
// item; Web Audio output alone gets play and pause but disables previous/next and seeking. So a silent looping
// <audio> element plays alongside the Web Audio output. iOS also ignores handlers registered before playback
// starts, and shows skip +-10 s in place of previous/next unless seekbackward/seekforward are explicitly null,
// so the handlers are registered again every time playback starts.
//
// Safari also copies the element's currentTime into the lock screen position whenever the element seeks or loops,
// so the silent element is as long as the song and its clock follows the song's position and speed. A short
// looping one would reset the lock screen to 0:00 on every loop and on every pause/play.

const SILENCE_RATE = 8000;
const SILENCE_MARGIN = 30; // seconds past the song's end, so the element never ends before the next song replaces it

function silentWavUrl(seconds) {
    // 8-bit mono silence at 8 kHz (8 KB per second)
    const samples = Math.ceil(seconds * SILENCE_RATE);
    const bytes = new Uint8Array(44 + samples).fill(128);
    const view = new DataView(bytes.buffer);
    const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    text(0, "RIFF");
    view.setUint32(4, 36 + samples, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, SILENCE_RATE, true);
    view.setUint32(28, SILENCE_RATE, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    text(36, "data");
    view.setUint32(40, samples, true);
    return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

export default class MediaSessionController {
    /** player: the AudioPlayer. previous / next: called for the lock screen track buttons. */
    constructor(player, { previous, next }) {
        this.player = player;
        this.previous = previous;
        this.next = next;
        this.supported = "mediaSession" in navigator;
        if (!this.supported) return;

        this.keepAlive = new Audio();
        this.keepAliveUrl = null;
        this.playbackState = "paused";

        this.registerHandlers();
        player.addEventListener("loadedmetadata", () => {
            this.loadKeepAlive();
            this.syncPosition();
        });
        player.addEventListener("play", () => this.onPlay());
        player.addEventListener("pause", () => this.onPause());
        player.addEventListener("seeked", () => {
            this.keepAlive.currentTime = this.player.currentTime;
            this.syncPosition();
        });
        player.addEventListener("ratechange", () => {
            this.keepAlive.playbackRate = this.player.playbackRate;
            this.syncPosition();
        });
    }

    /** A silent track just longer than the current song. The same element is reused so iOS keeps letting it play. */
    loadKeepAlive() {
        if (!isFinite(this.player.duration)) return;
        if (this.keepAliveUrl) URL.revokeObjectURL(this.keepAliveUrl);
        this.keepAliveUrl = silentWavUrl(this.player.duration + SILENCE_MARGIN);
        this.keepAlive.src = this.keepAliveUrl;
    }

    registerHandlers() {
        const session = navigator.mediaSession;
        const set = (action, handler) => {
            try {
                session.setActionHandler(action, handler);
            } catch {
                // action not supported by this browser
            }
        };
        set("play", () => this.player.play());
        set("pause", () => this.player.pause());
        set("previoustrack", this.previous);
        set("nexttrack", this.next);
        set("seekbackward", null);
        set("seekforward", null);
    }

    setMetadata(song) {
        if (!this.supported) return;
        navigator.mediaSession.metadata = new MediaMetadata({
            title: song.name,
            artwork: song.artwork ? [{ src: song.artwork }] : [],
        });
    }

    onPlay() {
        // loading a new source resets these, so set them on every play
        this.keepAlive.currentTime = this.player.currentTime;
        this.keepAlive.playbackRate = this.player.playbackRate;
        this.keepAlive.play().catch(() => {});
        this.playbackState = "playing";
        this.registerHandlers();
        this.syncPosition();
    }

    onPause() {
        // a song change pauses the player briefly; keep the session open through it
        if (this.player.loading) return;
        this.keepAlive.pause();
        this.playbackState = "paused";
        this.syncPosition();
    }

    syncPosition() {
        const { duration, playbackRate, currentTime } = this.player;
        if (!isFinite(duration)) return;
        navigator.mediaSession.setPositionState({
            duration,
            playbackRate,
            position: Math.min(currentTime, duration),
        });
        // set again after every position update, or the lock screen scrubber keeps moving while paused
        navigator.mediaSession.playbackState = this.playbackState;
    }
}
