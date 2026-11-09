// Tiny browser-test harness: a static server for the app, a headless Chrome driven over the DevTools protocol, and a
// per-platform measure of the page's memory. No dependencies; needs Node 22 (global WebSocket) and a Chrome install
// (set CHROME_PATH if it isn't in a standard place).
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIME = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".m4a": "audio/mp4",
    ".bin": "application/octet-stream",
    ".png": "image/png",
    ".jpg": "image/jpeg",
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exits quietly when the environment can't run browser tests, except in CI where that is a failure. */
export function requireBrowserEnvironment() {
    const problems = [];
    if (typeof WebSocket === "undefined") problems.push("Node 22+ is required (global WebSocket)");
    if (!fs.existsSync(path.join(ROOT, "dist", "bundle.js"))) problems.push("dist/ is missing: run `npm run build` first");
    if (!fs.existsSync(path.join(ROOT, "music", "index.json"))) problems.push("music/index.json is missing: run `npm run build` first");
    if (!findChrome()) problems.push("no Chrome found (set CHROME_PATH)");
    if (problems.length === 0) return;
    const message = `browser tests cannot run: ${problems.join("; ")}`;
    if (process.env.CI) throw new Error(message);
    console.log(`skipped: ${message}`);
    process.exit(0);
}

export function songNames() {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "music", "index.json"), "utf8")).map((song) => song.name);
}

export function startServer() {
    const server = createServer((request, response) => {
        const requested = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
        const file = path.join(ROOT, requested === "/" ? "index.html" : requested);
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
        fs.createReadStream(file).pipe(response);
    });
    return new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () =>
            resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }),
        ),
    );
}

function findChrome() {
    return [
        process.env.CHROME_PATH,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ]
        .filter(Boolean)
        .find((candidate) => fs.existsSync(candidate));
}

class Cdp {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 0;
        this.waiting = new Map();
        this.listeners = [];
        socket.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.id && this.waiting.has(message.id)) {
                this.waiting.get(message.id)(message);
                this.waiting.delete(message.id);
            } else if (message.method) {
                this.listeners.forEach((listener) => listener(message));
            }
        };
    }

    static async connect(url) {
        const socket = new WebSocket(url);
        await new Promise((resolve, reject) => {
            socket.onopen = resolve;
            socket.onerror = reject;
        });
        return new Cdp(socket);
    }

    send(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++this.nextId;
            this.waiting.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    on(listener) {
        this.listeners.push(listener);
    }
}

export async function launchBrowser() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "music-player-chrome-"));
    const args = [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--autoplay-policy=no-user-gesture-required",
        "--no-first-run",
        "--no-default-browser-check",
        "--mute-audio",
        "--window-size=1280,800",
        "about:blank",
    ];
    // CI containers and recent Ubuntu runners can't use Chrome's sandbox
    if (process.env.CI) args.push("--no-sandbox", "--disable-gpu");
    const chrome = spawn(findChrome(), args, { stdio: "ignore" });

    let port;
    for (let i = 0; i < 100 && !port; i++) {
        try {
            port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
        } catch {
            await sleep(100);
        }
    }
    if (!port) throw new Error("Chrome did not start");

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const browserCdp = await Cdp.connect(version.webSocketDebuggerUrl);

    return {
        port,
        /** `beforeLoad(page)` runs before navigation, e.g. to slow down a request. */
        async openPage(url, beforeLoad) {
            const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
            const cdp = await Cdp.connect(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
            const errors = [];
            cdp.on((message) => {
                if (message.method === "Runtime.exceptionThrown") {
                    const details = message.params.exceptionDetails;
                    errors.push(details.exception?.description || details.text);
                }
            });
            await cdp.send("Runtime.enable");
            await cdp.send("Page.enable");
            await cdp.send("HeapProfiler.enable");
            const page = new Page(cdp, errors);
            if (beforeLoad) await beforeLoad(page);
            await cdp.send("Page.navigate", { url });
            return page;
        },
        /** The page's renderer memory in MB (see footprintMB). */
        async rendererMB() {
            const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
            const sizes = processInfo.filter((p) => p.type === "renderer").map((p) => footprintMB(p.id));
            return Math.max(0, ...sizes);
        },
        async close() {
            const exited = new Promise((resolve) => chrome.once("exit", resolve));
            chrome.kill();
            await Promise.race([exited, sleep(5000)]);
            fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        },
    };
}

class Page {
    constructor(cdp, errors) {
        this.cdp = cdp;
        this.errors = errors;
    }

    async eval(expression) {
        const { result, exceptionDetails } = await this.cdp.send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (exceptionDetails) throw new Error(`page eval failed: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
        return result.value;
    }

    /** Polls `expression` in the page until it is truthy. */
    async waitFor(expression, { timeout = 15000, what = expression } = {}) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (await this.eval(`Boolean(${expression})`)) return;
            await sleep(100);
        }
        throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
    }

    /** Holds back responses for requests matching `urlPattern` (e.g. "*pghi-vocoder.js") by `ms`. */
    async delayRequests(urlPattern, ms) {
        await this.cdp.send("Fetch.enable", { patterns: [{ urlPattern }] });
        this.cdp.on((message) => {
            if (message.method !== "Fetch.requestPaused") return;
            setTimeout(() => this.cdp.send("Fetch.continueRequest", { requestId: message.params.requestId }).catch(() => {}), ms);
        });
    }

    click(selector) {
        return this.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
    }

    /** Sets a range slider the way a drag would, so the app's input handlers run. */
    setSlider(selector, value) {
        return this.eval(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${value}; el.dispatchEvent(new Event("input", { bubbles: true })); })()`,
        );
    }

    /** Collects garbage so a reading reflects what is really still held. */
    async collectGarbage() {
        await this.cdp.send("HeapProfiler.collectGarbage");
        await sleep(1500);
    }
}

/**
 * Physical memory of a process in MB, compressed/swapped memory included (RSS isn't comparable across runs on macOS
 * because the OS compresses idle pages). Returns 0 where it can't be measured.
 */
export function footprintMB(pid) {
    try {
        if (process.platform === "darwin") {
            const match = execSync(`footprint -p ${pid} 2>/dev/null | grep -m1 "Footprint:"`)
                .toString()
                .match(/Footprint:\s+([\d.]+)\s*(KB|MB|GB)/);
            return match ? Math.round(parseFloat(match[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2]]) : 0;
        }
        if (process.platform === "linux") {
            const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
            const kb = (name) => Number((rollup.match(new RegExp(`^${name}:\\s+(\\d+) kB`, "m")) || [])[1] || 0);
            return Math.round((kb("Pss") + kb("Swap")) / 1024);
        }
    } catch {
        // process gone, or not readable
    }
    return 0;
}
