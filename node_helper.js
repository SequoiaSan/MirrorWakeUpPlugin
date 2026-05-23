"use strict";

/**
 * node_helper.js – MMM-WakeUpSensor
 *
 * Runs on the Raspberry Pi server side.
 *
 * Instead of loading the `pigpio` native binding into Electron (which
 * frequently fails with "Module did not self-register" after a Node or
 * Electron upgrade), all GPIO work is delegated to small external OS
 * processes whose stdout we parse:
 *
 *   PIR sensor   – `gpiomon` (libgpiod, pre-installed on Pi OS) watches
 *                  for rising edges on the PIR pin.
 *   HC-SR04      – `python3 scripts/hcsr04.py` uses gpiozero to do the
 *                  10 µs trigger and microsecond-precision echo timing
 *                  in a separate process, then prints distances (cm)
 *                  one per line.
 *
 * This mirrors the approach used by modules like MMM-Universal-Pir:
 * no native addons are loaded into Electron, so there is nothing to
 * rebuild for the current Node/Electron ABI.
 *
 * Sends to the frontend:
 *   PIR_DETECTED       {}
 *   DISTANCE_MEASURED  { distance: <number cm> }
 *   SENSOR_ERROR       { error: <string> }
 */

const NodeHelper = require("node_helper");
const { spawn, execFileSync } = require("child_process");
const path       = require("path");
const readline   = require("readline");

// Detect the major version of the installed `gpiomon` (libgpiod) binary.
// libgpiod v1.x (Pi OS up to Bullseye) accepts:
//     gpiomon -r -F "%e %o" <chip> <offset>
// libgpiod v2.x (Pi OS Bookworm and later) redesigned the CLI and no
// longer accepts `-r` or a positional chip; the equivalent invocation is:
//     gpiomon -e rising -c <chip> -F "%e %o" <offset>
// Calling the v1 syntax against a v2 binary fails with
// "invalid argument -r".  We probe `gpiomon --version` once and cache the
// result so we can build the right command line.
let _gpiomonMajor = null;
function gpiomonMajorVersion() {
    if (_gpiomonMajor !== null) { return _gpiomonMajor; }
    try {
        const out = execFileSync("gpiomon", ["--version"],
                                 { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const m = out.match(/v?(\d+)\.(\d+)/);
        if (m) { _gpiomonMajor = parseInt(m[1], 10); }
    } catch (e) {
        // Binary missing or refused to report a version – leave unknown so
        // the caller can decide on a sensible default and surface the real
        // spawn error to the user.
    }
    if (_gpiomonMajor === null) { _gpiomonMajor = 0; }
    return _gpiomonMajor;
}

module.exports = NodeHelper.create({

    // ── Lifecycle ──────────────────────────────────────────────────────────
    start: function () {
        console.log("[MMM-WakeUpSensor] Node helper starting.");
        this._resetState();
    },

    _resetState: function () {
        this.config       = null;
        this.pirProc      = null;
        this.ultrasonicProc = null;
    },

    // ── Socket notifications from frontend ─────────────────────────────────
    socketNotificationReceived: function (notification, payload) {
        if (notification === "CONFIG") {
            this.config = payload;
            this._initSensors();
        }
    },

    // ── Sensor initialisation ──────────────────────────────────────────────
    _initSensors: function () {
        try {
            this._setupPir();
            this._setupUltrasonic();
            console.log("[MMM-WakeUpSensor] Sensors initialised. " +
                        "PIR pin: " + this.config.pirPin +
                        ", TRIG: "  + this.config.trigPin +
                        ", ECHO: "  + this.config.echoPin);
        } catch (err) {
            const msg = "Sensor init failed – " + err.message;
            console.error("[MMM-WakeUpSensor] " + msg);
            this.sendSocketNotification("SENSOR_ERROR", { error: msg });
        }
    },

    // ── PIR (via gpiomon from libgpiod) ────────────────────────────────────
    //
    // `gpiomon` prints one line for every requested edge event.  We ask
    // for rising edges only and let it run forever.  The CLI changed
    // between libgpiod v1 and v2, so we build different argv lists per
    // version (see `gpiomonMajorVersion` above).  Pi OS Bookworm renamed
    // the chip to `gpiochip4` on Pi 5, but libgpiod also accepts the chip
    // label – we let the user override via config.pirChip and default to
    // "gpiochip0" which works on Pi 1–4.  The script tries gpiochip0
    // first, then gpiochip4 as a fallback if the first attempt exits
    // immediately.
    _setupPir: function () {
        const pin  = this.config.pirPin;
        const chip = this.config.pirChip || "gpiochip0";

        this._spawnGpiomon(chip, pin, /*allowFallback=*/ chip === "gpiochip0");
    },

    _spawnGpiomon: function (chip, pin, allowFallback) {
        // Format `%e %o` (event type + offset) is accepted by both v1 and
        // v2.  When the version probe fails (binary missing or unparsable
        // --version output) we assume v2 because that is what current Pi
        // OS releases ship; a missing binary will still surface a clear
        // "Failed to spawn gpiomon" error below.
        const major = gpiomonMajorVersion();
        const args = (major === 1)
            ? ["-r", "-F", "%e %o", chip, String(pin)]
            : ["-e", "rising", "-c", chip, "-F", "%e %o", String(pin)];

        let proc;
        try {
            proc = spawn("gpiomon", args, { stdio: ["ignore", "pipe", "pipe"] });
        } catch (err) {
            const msg = "Failed to spawn gpiomon: " + err.message +
                        ". Install with: sudo apt install gpiod";
            console.error("[MMM-WakeUpSensor] " + msg);
            this.sendSocketNotification("SENSOR_ERROR", { error: msg });
            return;
        }

        this.pirProc = proc;
        const startedAt = Date.now();

        proc.on("error", (err) => {
            if (this.pirProc !== proc) { return; }
            const msg = "gpiomon error: " + err.message +
                        ". Install with: sudo apt install gpiod";
            console.error("[MMM-WakeUpSensor] " + msg);
            this.sendSocketNotification("SENSOR_ERROR", { error: msg });
        });

        const stderrChunks = [];
        proc.stderr.on("data", (buf) => {
            stderrChunks.push(buf.toString());
        });

        const rl = readline.createInterface({ input: proc.stdout });
        rl.on("line", (line) => {
            // Any line on stdout means a rising edge was observed.
            if (line && line.length > 0) {
                this.sendSocketNotification("PIR_DETECTED", {});
            }
        });

        proc.on("exit", (code, signal) => {
            if (this.pirProc !== proc) { return; } // superseded / stopped
            this.pirProc = null;
            const stderr = stderrChunks.join("").trim();
            const elapsed = Date.now() - startedAt;

            // If gpiomon exits almost immediately and the user is on a Pi 5
            // (Bookworm), try gpiochip4 as a fallback. We only attempt the
            // fallback once.
            if (allowFallback && elapsed < 2000) {
                console.warn("[MMM-WakeUpSensor] gpiomon on " + chip +
                             " exited (code=" + code + ", signal=" + signal +
                             "); retrying with gpiochip4. stderr: " + stderr);
                this._spawnGpiomon("gpiochip4", pin, /*allowFallback=*/ false);
                return;
            }

            const msg = "gpiomon exited unexpectedly (code=" + code +
                        ", signal=" + signal + "). " +
                        (stderr ? "stderr: " + stderr + ". " : "") +
                        "Ensure the `gpiod` package is installed " +
                        "(sudo apt install gpiod) and that the user " +
                        "running MagicMirror has access to " + chip +
                        " (gpio group).";
            console.error("[MMM-WakeUpSensor] " + msg);
            this.sendSocketNotification("SENSOR_ERROR", { error: msg });
        });
    },

    // ── Ultrasonic (HC-SR04, via Python helper) ────────────────────────────
    _setupUltrasonic: function () {
        const trig     = this.config.trigPin;
        const echo     = this.config.echoPin;
        const interval = Math.max(0.05, (this.config.ultrasonicInterval || 1000) / 1000);
        const script   = path.join(__dirname, "scripts", "hcsr04.py");

        let proc;
        try {
            proc = spawn("python3",
                         [script, String(trig), String(echo), String(interval)],
                         { stdio: ["ignore", "pipe", "pipe"] });
        } catch (err) {
            const msg = "Failed to spawn python3 for HC-SR04 helper: " +
                        err.message +
                        ". Install with: sudo apt install python3 python3-gpiozero";
            console.error("[MMM-WakeUpSensor] " + msg);
            this.sendSocketNotification("SENSOR_ERROR", { error: msg });
            return;
        }

        this.ultrasonicProc = proc;

        proc.on("error", (err) => {
            if (this.ultrasonicProc !== proc) { return; }
            const msg = "HC-SR04 helper error: " + err.message;
            console.error("[MMM-WakeUpSensor] " + msg);
            this.sendSocketNotification("SENSOR_ERROR", { error: msg });
        });

        const stderrChunks = [];
        proc.stderr.on("data", (buf) => {
            const text = buf.toString();
            stderrChunks.push(text);
            // Forward each stderr line so it shows up in MagicMirror logs.
            text.split(/\r?\n/).forEach((line) => {
                if (line.trim().length > 0) {
                    console.warn("[MMM-WakeUpSensor] hcsr04.py: " + line);
                }
            });
        });

        const rl = readline.createInterface({ input: proc.stdout });
        rl.on("line", (line) => {
            const trimmed = line.trim();
            if (trimmed.length === 0) { return; }
            const distance = parseFloat(trimmed);
            if (!isFinite(distance)) { return; }

            // Match the contract of the previous implementation:
            // valid HC-SR04 range is 2 cm – 400 cm; anything else is 9999.
            if (distance >= 2 && distance <= 400) {
                this.sendSocketNotification("DISTANCE_MEASURED", { distance });
            } else {
                this.sendSocketNotification("DISTANCE_MEASURED", { distance: 9999 });
            }
        });

        proc.on("exit", (code, signal) => {
            if (this.ultrasonicProc !== proc) { return; } // superseded / stopped
            this.ultrasonicProc = null;
            const stderr = stderrChunks.join("").trim();
            const msg = "HC-SR04 helper exited unexpectedly (code=" + code +
                        ", signal=" + signal + "). " +
                        (stderr ? "stderr: " + stderr + ". " : "") +
                        "Ensure python3 and gpiozero are installed " +
                        "(sudo apt install python3 python3-gpiozero) and " +
                        "that the user running MagicMirror is in the gpio group.";
            console.error("[MMM-WakeUpSensor] " + msg);
            this.sendSocketNotification("SENSOR_ERROR", { error: msg });
        });
    },

    // ── Cleanup ────────────────────────────────────────────────────────────
    stop: function () {
        console.log("[MMM-WakeUpSensor] Stopping node helper.");

        for (const key of ["pirProc", "ultrasonicProc"]) {
            const proc = this[key];
            if (proc) {
                this[key] = null; // clear first so the 'exit' handler ignores it
                try { proc.kill("SIGTERM"); } catch (e) { /* ignore */ }
            }
        }

        this._resetState();
    }
});
