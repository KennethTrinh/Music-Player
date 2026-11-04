# Music-Player

Pitch Shifter in javascript!

## Prerequisites

```
npm install
npm run build
```

In one terminal:

```
npm run watch
```

In another terminal:

```
npm run start
```

[Website](https://kennethtrinh.github.io/Music-Player/)

## Keyboard Controls

This application supports the following keyboard controls for ease of use:

- **ArrowDown / s**: Pressing the down arrow / 's' key will skip to the next song in the playlist.

- **ArrowUp / w**: Pressing the up arrow / 'w' key will go back to the previous song in the playlist.

- **ArrowRight**: Pressing the right arrow key will increase the pitch factor of the current song by 1.

- **ArrowLeft**: Pressing the left arrow key will decrease the pitch factor of the current song by 1.

- **r**: Pressing the 'r' key will repeat the current song. The song ID is used to identify which song to repeat.

- **d**: Pressing the 'd' key will delete the current song from the playlist. The song ID is used to identify which song to delete.

- **p**: Pressing the 'p' key will play or pause the current song, depending on its current state.

- **f**: Pressing the 'f' key will open the file input dialog, allowing you to select a new song file to add to the playlist.

## How the pitch shift works

The pitch shifter is a **frequency-domain (phase vocoder style) shifter** that runs in an
`AudioWorklet` (`src/phase-vocoder.js`, built on the overlap-add scaffolding in `src/ola-processor.js`).
Instead of resampling the audio, it works out which frequencies are present, moves them, and rebuilds the sound.

This section has three parts: the [background math](#background-the-math-no-dsp-knowledge-needed),
the [pipeline](#the-pipeline) as implemented here, and a [toy example](#toy-example-one-sine-wave-through-the-whole-pipeline)
that pushes a tiny sound through every step with real numbers.

### Background: the math (no DSP knowledge needed)

**Sound is a list of numbers.** A microphone measures air pressure thousands of times a second. Each
measurement is one number, called a _sample_. At 44.1 kHz there are 44,100 samples per second, and playing them
back in order recreates the sound.

**Pitch is how fast the wave wiggles.** A pure tone is a sine wave, and its _frequency_ (wiggles per second, in Hz)
is what we hear as pitch. 440 Hz is the note A4. Our ears hear pitch by ratio, not by difference:

- Doubling the frequency is one octave up (880 Hz is also an "A").
- One semitone (one piano key) is a factor of 2^(1/12) ≈ 1.0595. Twelve of them multiply to exactly 2, an octave.

So shifting a song up `n` semitones means multiplying every frequency in it by `2^(n/12)`.

**Why not just play it faster?** Speeding up playback does multiply every frequency, but it also makes the song
shorter. Chipmunk voices are exactly that. We want the pitch to change while the length stays the same, so
we cannot touch the timing. We have to change the frequencies _inside_ each moment of sound.

**The Fourier transform: sound is a recipe of sine waves.** The key fact is that any short stretch of sound is
the sum of sine waves of different frequencies, each with its own loudness. A chord is literally three or four sines added up. The
_Fourier transform_ (computed quickly by the **FFT**) takes `N` samples and tells you how much of each frequency is in them.
The output is a list of `N/2 + 1` slots called _bins_. Bin `k` stands for the frequency

```
frequency of bin k = k * sampleRate / N
```

For each bin the FFT returns a _complex number_ `re + im·i`. Think of it as an arrow on a plane with two properties:

- its **length** (the _magnitude_, `√(re² + im²)`) says how loud that frequency is,
- its **angle** (the _phase_) says where in its wiggle the sine wave currently is, that is, how far it is shifted in time.

Plotted as magnitude per bin, you get the _spectrum_. A musical note shows up as a few tall spikes (the
**peaks**): the fundamental and its harmonics at 2x, 3x, 4x, ... the fundamental frequency.

**The shift is a move along the frequency axis.** Because bin `k` means frequency `k * sampleRate / N`, multiplying a
frequency by `pitchFactor` means moving its energy from bin `k` to bin `k * pitchFactor`. Spikes at 1x, 2x, 3x
become spikes at 1.5x, 3x, 4.5x (for a factor of 1.5), so the harmonic relationship that gives an instrument its timbre is
preserved. Then the _inverse FFT_ turns the new spectrum back into samples. The duration never changed, only
what was inside it.

Three complications make the real thing a bit more involved:

1. **Sounds change over time, the FFT sees one frozen snapshot.** So we cut the audio into short _frames_ (4096 samples,
   about 93 ms) and process each one. To avoid clicks at the cut edges, each frame is multiplied by a **Hann window**, a smooth bump that fades the
   frame in and out, and frames **overlap** (a new frame starts every 128 samples). After processing, the frames are added back
   together (_overlap-add_) so the fades of neighbouring frames sum to a steady signal.
2. **Windowing smears each spike a little.** A pure sine, once windowed, shows up in its own bin plus a half-height
   copy in each neighbour. So we cannot move just one bin. We find each peak and move the whole neighbourhood
   around it (its _region of influence_) together.
3. **Phases must be kept consistent between frames.** Frame 2 starts a few samples after frame 1, so a sine wave in it
   has already advanced by some angle. If we move that sine to a new frequency, it should advance by a
   _different_ angle per frame (a faster sine turns further in the same time). If we ignored this, each frame's output would be
   misaligned with the previous one, the overlapping frames would partly cancel, and you would hear a
   warbling, robotic sound. The fix is to rotate every moved bin's arrow by the extra angle needed. Multiplying
   a complex number by `cos θ + i·sin θ` rotates its arrow by `θ` without changing its length. That `θ` works out to
   `2π * (k' - k) / N * timeCursor`, where `k` is the old bin, `k'` the new bin and `timeCursor` is
   how many samples into the song this frame starts.

### The pipeline

**Slider to ratio.** The pitch slider is in semitones and is converted with `pitchFactor = 2^(semitones / 12)`:

| Semitones | pitchFactor | Effect          |
| --------- | ----------- | --------------- |
| -12       | 0.5         | one octave down |
| 0         | 1.0         | unchanged       |
| +2        | 1.1225      | up a whole tone |
| +12       | 2.0         | one octave up   |

The speed slider uses the same formula but sets `audioElement.playbackRate`, so speed and pitch are independent controls.

**Per frame.** Audio arrives in 128-sample blocks. The processor keeps a sliding window of `4096` samples and, every 128
samples (a _hop_), does:

1. **Window** the samples with a Hann window.
2. **FFT** to get the spectrum.
3. **Find peaks**: bins whose magnitude is larger than both neighbours.
4. **Shift peaks**: each peak at bin `k` moves to bin `round(k * pitchFactor)`, taking its region of influence (up to the midpoint
   to the next peak) with it. Everything lands in a zero-filled spectrum, and overlapping contributions are added.
5. **Phase-correct** each moved bin as described above.
6. **Inverse FFT** back to samples, then Hann window again.
7. **Overlap-add** into the output buffer, divided by the number of overlaps (4096 / 128 = 32), and send the oldest 128 samples to the speakers.

Because the first full window has to fill up before anything comes out, this adds roughly 4096 / 44100 ≈ 93 ms of latency.

### Toy example: one sine wave through the whole pipeline

To keep every number small and checkable, shrink the real settings:

|                         | Real player | Toy       |
| ----------------------- | ----------- | --------- |
| Frame size `N`          | 4096        | 16        |
| Hop                     | 128         | 4         |
| Overlaps per sample     | 32          | 4         |
| Sample rate             | 44100 Hz    | 16 Hz     |
| Bin width (rate / N)    | 10.77 Hz    | 1 Hz      |

With a 1 Hz bin width, bin `k` is simply `k` Hz. The input is a pure **3 Hz sine wave**,
`x[n] = sin(2π · 3 · n / 16)`, and we shift it up an **octave** (`pitchFactor = 2`), so the answer should be a **6 Hz sine**.

**Step 0: the input frame** (the first 16 samples, `timeCursor = 0`):

```
n   :  0     1     2     3     4     5     6     7     8     9     10    11    12    13    14    15
x[n]:  0.000 0.924 0.707 -0.383 -1.000 -0.383 0.707 0.924 0.000 -0.924 -0.707 0.383 1.000 0.383 -0.707 -0.924
```

**Step 1: Hann window.** `w[n] = 0.5 · (1 - cos(2πn / 16))` is 0 at the edges and 1 in the middle. Multiplying sample by sample:

```
w[n]   :  0.000 0.038 0.146 0.309 0.500 0.691 0.854 0.962 1.000 0.962 0.854 0.691 0.500 0.309 0.146 0.038
x·w[n] :  0.000 0.035 0.104 -0.118 -0.500 -0.265 0.604 0.889 0.000 -0.889 -0.604 0.265 0.500 0.118 -0.104 -0.035
```

**Step 2: FFT.** Only three bins have anything in them (rounded to 3 decimals):

```
bin       :  0    1    2       3        4       5    6    7    8
re + im·i :  0    0    0+2i    0-4i     0+2i    0    0    0    0
magnitude²:  0    0    4       16       4       0    0    0    0
```

The loudest bin is 3, exactly the 3 Hz we put in. Bins 2 and 4 are the half-height smear from the windowing
(2 is half of 4, and their arrows point the opposite way).

**Step 3: find peaks.** Bin 3 is the only bin larger than both of its neighbours (16 > 4 and 16 > 4). Since there is just one peak,
its region of influence is everything, but only bins 2 through 4 have energy.

**Step 4: shift the peak.** The new bin is `round(3 × 2) = 6`, so every bin of the region moves by `+3`:

```
old bin 2 (0+2i)  -> new bin 5
old bin 3 (0-4i)  -> new bin 6    <- 6 Hz
old bin 4 (0+2i)  -> new bin 7
```

All other bins of the new spectrum stay zero. The relative shape (small, big, small) is kept.

**Step 5: phase correction.** Rotate each moved bin by `θ = 2π · (k' - k) / N · timeCursor = 2π · 3 / 16 · timeCursor`.

- **Frame 1** (`timeCursor = 0`): `θ = 0`, nothing changes. The new spectrum is `5: 0+2i, 6: 0-4i, 7: 0+2i`.
- **Frame 2** starts 4 samples later (`timeCursor = 4`). The same 3 Hz sine is now a quarter-turn-and-a-half further along
  (2π · 3 · 4 / 16 = 3π/2), so its FFT is `2: 2, 3: -4, 4: 2` (real numbers now, because the wave has rotated). A true 6 Hz sine would have
  advanced 3π over those 4 samples, so we owe it the missing `θ = 2π · 3 · 4 / 16 = 3π/2`:
  `cos θ = 0, sin θ = -1`, and `(re + im·i) · (0 - 1·i)` turns `-4` into `0+4i`, and the `2`s into `0-2i`. Frame 2's shifted spectrum is
  `5: 0-2i, 6: 0+4i, 7: 0-2i`.

Without this step frame 2 would carry the phase of a 3 Hz wave and would not line up with frame 1's 6 Hz output.

**Step 6: inverse FFT and window again.** For frame 1 the inverse FFT gives a 6 Hz sine under a Hann-shaped envelope
(the leftover of step 1's window). Windowing again, to fade the frame's edges before overlapping, gives:

```
n  :  0     1     2      3     4     5      6     7      8     9     10     11    12    13     14    15
out:  0.000 0.001 -0.021 0.067 0.000 -0.338 0.729 -0.654 0.000 0.654 -0.729 0.338 0.000 -0.067 0.021 -0.001
```

**Step 7: overlap-add.** Add each processed frame into the output at its own start position (0, 4, 8, 12, ...) and divide by the 4 overlaps.
Once four frames overlap (from sample 12 onward) the output settles to:

```
n          :  24    25     26     27     28    29     30     31
output[n]  :  0.000 0.265  -0.375 0.265  0.000 -0.265 0.375  -0.265
sin(2π·6n/16): 0.000 0.707 -1.000 0.707  0.000 -0.707 1.000  -0.707
ratio      :  -     0.375  0.375  0.375  -     0.375  0.375  0.375
```

The output is a clean 6 Hz sine: it completes a cycle every 8 samples, twice as fast as the 16-sample cycle of the 3 Hz input. It's the same
length as the input and one octave higher. The constant 0.375 factor is the gain of the two Hann windows after
dividing by the overlap count (the average of `w²`, which is 3/8). A real signal is just many such sines at once,
and each spectral peak goes through the same steps.

**Scaling to the real player.** The bins are 10.77 Hz wide instead of 1 Hz, and bins are whole numbers,
so the new peak position gets rounded. Shifting A4 (440 Hz, bin 41) up 2 semitones:

```
pitchFactor       = 2^(2/12)            = 1.1225
shifted bin       = round(41 * 1.1225)  = round(46.02) = 46
shifted frequency = 46 * 10.77          ≈ 495.2 Hz
```

The ideal B4 is 493.88 Hz, so the result is about 1.3 Hz sharp (less than a quarter of a semitone). That rounding is the price of snapping to whole
bins. Overtones go through the same maths (880 Hz: bin 82 → 92), so they stay in tune with the fundamental.

### Limitations

- Shifting snaps to whole bins, so pitch accuracy is limited to the bin width (about 10.77 Hz at 44.1 kHz). The error is
  most noticeable at low pitches, where one bin is a large fraction of a semitone.
- Phase correction here is based on the running `timeCursor` rather than on the measured phase of each frame (the
  `previousPhase` and `phaseCumulative` buffers are allocated but unused), so large shifts on sustained notes can sound slightly
  metallic or smeared.
