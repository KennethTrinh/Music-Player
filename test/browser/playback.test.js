// The everyday paths in a real browser: play, next, previous, pitch and speed. Deliberately small: unit tests cover
// the DSP (pghi.test.js); this checks the page is wired up and that a user's basic actions work.
import assert from "node:assert";
import { launchBrowser, requireBrowserEnvironment, songNames, startServer } from "./helpers.js";

requireBrowserEnvironment();
const songs = songNames();
assert.ok(songs.length >= 4, "these tests walk through 4 songs");
const at = (index) => songs[index % songs.length]; // the playlist wraps around

const server = await startServer();
const browser = await launchBrowser();
const timer = setTimeout(() => {
    console.error("browser tests timed out");
    process.exit(1);
}, 4 * 60 * 1000);

let failed = false;
try {
    // the vocoder script is held back so the first load is slow enough to press next in the middle of it
    const page = await browser.openPage(server.url, (p) => p.delayRequests("*pghi-vocoder.js", 1500));
    const title = () => page.eval(`document.querySelector("h1").textContent`);

    /** Song seconds that pass per real second, measured over `ms` of wall-clock time. */
    const playbackRate = (ms) =>
        page.eval(`new Promise((resolve) => {
            const seek = document.querySelector("#seek");
            const from = Number(seek.value);
            const start = performance.now();
            setTimeout(() => resolve((Number(seek.value) - from) / ((performance.now() - start) / 1000)), ${ms});
        })`);

    /** Waits for the named song to be loaded and playing from the start. */
    const playingFromStart = async (name) => {
        await page.waitFor(
            `document.querySelector("h1").textContent === ${JSON.stringify(name)}
             && document.querySelector("#play-btn").getAttribute("aria-label") === "Pause"
             && Number(document.querySelector("#seek").value) < 3
             && document.querySelector("#time-total").textContent !== "0:00"`,
            { timeout: 20000, what: `"${name}" playing from the start` },
        );
        await page.waitFor(`Number(document.querySelector("#seek").value) > 1`, { what: "playback advancing" });
    };

    const step = async (name, run) => {
        process.stdout.write(`  ${name} ... `);
        await run();
        console.log("ok");
    };
    console.log("playback.test.js");

    await step("pressing next while the first song is still loading is handled", async () => {
        // the title is set as soon as the first load starts; its audio engine is still waiting on the vocoder script
        await page.waitFor(`document.querySelector("h1").textContent === ${JSON.stringify(songs[0])}`, { what: "first song title" });
        assert.strictEqual(await page.eval(`document.querySelector("#no-worklet").style.display`), "none", "audio worklet should be available");
        await page.click("#next-btn");
        await playingFromStart(at(1));
    });

    await step("pause stops the clock and play resumes it", async () => {
        await page.click("#play-btn");
        await page.waitFor(`document.querySelector("#play-btn").getAttribute("aria-label") === "Play"`, { what: "paused" });
        assert.ok(Math.abs(await playbackRate(1500)) < 0.05, "song time should stand still while paused");
        await page.click("#play-btn");
        await page.waitFor(`document.querySelector("#play-btn").getAttribute("aria-label") === "Pause"`, { what: "playing" });
        assert.ok((await playbackRate(2000)) > 0.8, "song time should advance again after resuming");
    });

    await step("next song starts the next song from 0:00", async () => {
        await page.click("#next-btn");
        await playingFromStart(at(2));
    });

    await step("tapping next twice quickly settles on the second song", async () => {
        await page.eval(`document.querySelector("#next-btn").click(); document.querySelector("#next-btn").click();`);
        await playingFromStart(at(4));
    });

    await step("previous song goes back", async () => {
        await page.click("#prev-btn");
        await playingFromStart(at(3));
    });

    await step("pitch shift updates the slider and leaves the tempo alone", async () => {
        await page.setSlider("#pitch", 5);
        assert.strictEqual(await page.eval(`document.querySelector("#pitch-value").textContent`), "5");
        const rate = await playbackRate(3000);
        assert.ok(rate > 0.85 && rate < 1.15, `pitch +5 should not change the speed, song time ran at ${rate.toFixed(2)}x`);
    });

    await step("speed shift changes the tempo and leaves the pitch setting alone", async () => {
        await page.setSlider("#speed", 12);
        assert.strictEqual(await page.eval(`document.querySelector("#speed-value").textContent`), "12");
        const fast = await playbackRate(3000);
        assert.ok(fast > 1.7 && fast < 2.3, `speed +12 should run at 2x, ran at ${fast.toFixed(2)}x`);

        await page.setSlider("#speed", -12);
        const slow = await playbackRate(3000);
        assert.ok(slow > 0.4 && slow < 0.6, `speed -12 should run at 0.5x, ran at ${slow.toFixed(2)}x`);

        await page.setSlider("#speed", 0);
        const normal = await playbackRate(2500);
        assert.ok(normal > 0.85 && normal < 1.15, `speed 0 should run at 1x, ran at ${normal.toFixed(2)}x`);
        assert.strictEqual(await page.eval(`document.querySelector("#pitch-value").textContent`), "5", "speed must not move the pitch slider");
    });

    await step("a song change keeps the pitch and speed settings", async () => {
        await page.setSlider("#speed", 12);
        await page.click("#next-btn");
        await playingFromStart(at(4));
        assert.strictEqual(await page.eval(`document.querySelector("#pitch-value").textContent`), "5");
        assert.strictEqual(await page.eval(`document.querySelector("#speed-value").textContent`), "12");
        const rate = await playbackRate(3000);
        assert.ok(rate > 1.7 && rate < 2.3, `speed should carry over to the next song, ran at ${rate.toFixed(2)}x`);
    });

    assert.deepStrictEqual(page.errors, [], "the page threw uncaught errors");
    console.log("all playback tests passed");
} catch (error) {
    failed = true;
    console.error(`\nFAILED: ${error.message}`);
} finally {
    clearTimeout(timer);
    await browser.close();
    server.close();
}
process.exit(failed ? 1 : 0);
