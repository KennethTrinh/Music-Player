// Memory stays reasonable: plays through a lot of song changes in a real browser and checks the page's footprint.
// Catches both a creeping leak (each song change used to leak a vocoder) and a new feature that balloons memory.
import assert from "node:assert";
import { launchBrowser, requireBrowserEnvironment, sleep, songNames, startServer } from "./helpers.js";

// What the page holds once garbage is collected (about 190 MB today). Checked after startup and after the song changes.
const LIMIT_MB = 400;
// Transient peak, e.g. while a song decodes and the previous one hasn't been freed yet, or key detection decodes the
// whole library at startup. This is higher than what is held: skipping quickly peaks around 500 MB today, and the
// decode-whole-song design makes it grow with song length. Looser on purpose, so it flags a regression, not the noise.
const PEAK_LIMIT_MB = 700;
const MAX_GROWTH_MB = 30; // between the 8th and the 40th song change, after garbage collection
const SONG_CHANGES = 40;

requireBrowserEnvironment();
const songs = songNames();

const server = await startServer();
const browser = await launchBrowser();
const timer = setTimeout(() => {
    console.error("memory test timed out");
    process.exit(1);
}, 6 * 60 * 1000);

let failed = false;
try {
    const page = await browser.openPage(server.url);
    let peak = 0;
    const peaks = { startup: 0, changes: 0 };
    let phase = "startup";
    const sample = async () => {
        const mb = await browser.rendererMB();
        peak = Math.max(peak, mb);
        peaks[phase] = Math.max(peaks[phase], mb);
    };

    console.log("memory.test.js");
    if ((await browser.rendererMB()) === 0) {
        const message = `cannot measure memory on ${process.platform}`;
        if (process.env.CI) throw new Error(message);
        console.log(`skipped: ${message}`);
        process.exit(0);
    }

    // startup: the first song decodes and key detection runs over the whole library; sample through all of it
    const startup = Date.now();
    while (Date.now() - startup < 60000) {
        await sample();
        const ready = await page.eval(`
            document.querySelector("#time-total").textContent !== "0:00" &&
            [...document.querySelectorAll(".song-key")].every((el) => el.textContent !== "")`);
        if (ready) break;
        await sleep(500);
    }
    await page.collectGarbage();
    const afterStartup = await browser.rendererMB();
    await page.click("#play-btn");
    await sleep(2000);
    phase = "changes";

    let after8;
    for (let n = 1; n <= SONG_CHANGES; n++) {
        const before = await page.eval(`document.querySelector("h1").textContent`);
        await page.click("#next-btn");
        await page.waitFor(
            `document.querySelector("h1").textContent !== ${JSON.stringify(before)}
             && Number(document.querySelector("#seek").value) > 0.5`,
            { timeout: 20000, what: `song change ${n} to finish` },
        );
        await sample();
        if (n === 8) {
            await page.collectGarbage();
            after8 = await browser.rendererMB();
        }
    }
    await page.collectGarbage();
    const final = await browser.rendererMB();
    peak = Math.max(peak, final);

    console.log(`  peak during startup ${peaks.startup} MB, during song changes ${peaks.changes} MB`);
    console.log(`  held after startup ${afterStartup} MB, after 8 changes ${after8} MB, after ${SONG_CHANGES} changes ${final} MB (limit ${LIMIT_MB} MB)`);
    console.log(`  transient peak ${peak} MB (limit ${PEAK_LIMIT_MB} MB), ${songs.length} songs`);
    for (const [label, mb] of [["after startup", afterStartup], ["after 8 song changes", after8], [`after ${SONG_CHANGES} song changes`, final]]) {
        assert.ok(mb < LIMIT_MB, `the page holds ${mb} MB ${label}, limit is ${LIMIT_MB} MB`);
    }
    assert.ok(peak < PEAK_LIMIT_MB, `memory peaked at ${peak} MB, limit is ${PEAK_LIMIT_MB} MB`);
    assert.ok(final - after8 < MAX_GROWTH_MB, `memory grew by ${final - after8} MB between song change 8 and ${SONG_CHANGES}: something leaks per song`);
    assert.deepStrictEqual(page.errors, [], "the page threw uncaught errors");
    console.log("memory test passed");
} catch (error) {
    failed = true;
    console.error(`\nFAILED: ${error.message}`);
} finally {
    clearTimeout(timer);
    await browser.close();
    server.close();
}
process.exit(failed ? 1 : 0);
