"use strict";

/**
 * node_helper.js – MMM-WakeUpSensor
 *
 * Runs on the Raspberry Pi server side.
 * Interfaces with hardware via the `pigpio` library:
 *
 *   PIR sensor   – digital GPIO input, alert on edge change
 *   HC-SR04      – 10 µs trigger pulse, echo pulse duration → distance in cm
 *
 * Sends to the frontend:
 *   PIR_DETECTED       {}
 *   DISTANCE_MEASURED  { distance: <number cm> }
 *   SENSOR_ERROR       { error: <string> }
 */

const NodeHelper = require("node_helper");

module.exports = NodeHelper.create({

    // ── Lifecycle ──────────────────────────────────────────────────────────
    start: function () {
        console.log("[MMM-WakeUpSensor] Node helper starting.");
        this._resetState();
    },

    _resetState: function () {
        this.config           = null;
        this.pirSensor        = null;
        this.usTrigger        = null;  // ultrasonic trigger GPIO
        this.usEcho           = null;  // ultrasonic echo GPIO
        this.measureInterval  = null;
        this.echoStartTick    = null;  // tick (µs) when echo went HIGH
        this.isMeasuring      = false; // guard against overlapping measurements
        this.measureTimeout   = null;  // safety timer per measurement
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
        let pigpio;
        try {
            pigpio = require("pigpio");
        } catch (err) {
            const msg = "pigpio not available – " + err.message +
                        ". Run: cd ~/MagicMirror/modules/MMM-WakeUpSensor && npm install";
            console.error("[MMM-WakeUpSensor] " + msg);
            this.sendSocketNotification("SENSOR_ERROR", { error: msg });
            return;
        }

        // pigpio's JS wrapper catches native-binding load failures (e.g. the
        // "Module did not self-register" error that occurs when the .node
        // binary was compiled against a different Node/Electron ABI than the
        // one currently running MagicMirror) and only prints a warning – the
        // require() above then succeeds with a non-functional stub. If we
        // proceed, `new Gpio(...)` later fails with the cryptic
        // "pigpio.gpioInitialise is not a function". Detect that case here
        // and surface a clear, actionable error instead.
        if (typeof pigpio.gpioInitialise !== "function") {
            const msg = "pigpio native binding failed to load (\"Module did " +
                        "not self-register\"). This usually means the binary " +
                        "was built against a different Node/Electron ABI than " +
                        "the one running MagicMirror. Rebuild it from the " +
                        "module folder: cd ~/MagicMirror/modules/MMM-WakeUpSensor " +
                        "&& npm rebuild pigpio --update-binary  (or, when " +
                        "running under Electron, use electron-rebuild). " +
                        "pigpio also requires a Raspberry Pi – it will not " +
                        "work on other hardware.";
            console.error("[MMM-WakeUpSensor] " + msg);
            this.sendSocketNotification("SENSOR_ERROR", { error: msg });
            return;
        }

        const Gpio = pigpio.Gpio;

        try {
            this._setupPir(Gpio);
            this._setupUltrasonic(Gpio);
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

    // ── PIR ────────────────────────────────────────────────────────────────
    _setupPir: function (Gpio) {
        this.pirSensor = new Gpio(this.config.pirPin, {
            mode:        Gpio.INPUT,
            pullUpDown:  Gpio.PUD_DOWN,
            alert:       true          // triggers the 'alert' event on edge changes
        });

        this.pirSensor.on("alert", (level) => {
            if (level === 1) {
                // Rising edge = motion detected
                this.sendSocketNotification("PIR_DETECTED", {});
            }
        });
    },

    // ── Ultrasonic (HC-SR04) ───────────────────────────────────────────────
    _setupUltrasonic: function (Gpio) {
        // Trigger pin – output
        this.usTrigger = new Gpio(this.config.trigPin, { mode: Gpio.OUTPUT });
        this.usTrigger.digitalWrite(0); // ensure LOW at start

        // Echo pin – input with µs-level alert
        this.usEcho = new Gpio(this.config.echoPin, {
            mode:  Gpio.INPUT,
            alert: true
        });

        // Capture echo pulse duration
        this.usEcho.on("alert", (level, tick) => {
            if (level === 1) {
                // Rising edge: echo started
                this.echoStartTick = tick;

            } else if (level === 0 && this.echoStartTick !== null) {
                // Falling edge: echo finished
                // Use unsigned subtraction to handle the 32-bit tick wrap-around
                // that occurs every ~71.5 minutes.
                const elapsedUs = ((tick - this.echoStartTick) >>> 0);
                this.echoStartTick = null;
                this.isMeasuring   = false;

                if (this.measureTimeout) {
                    clearTimeout(this.measureTimeout);
                    this.measureTimeout = null;
                }

                // HC-SR04: distance (cm) = elapsed (µs) / 58.2
                // Valid range: 2 cm – 400 cm
                const distance = elapsedUs / 58.2;

                if (distance >= 2 && distance <= 400) {
                    this.sendSocketNotification("DISTANCE_MEASURED", { distance });
                } else {
                    // Out-of-range reading – report as very far away
                    this.sendSocketNotification("DISTANCE_MEASURED", { distance: 9999 });
                }
            }
        });

        // Periodic trigger
        this.measureInterval = setInterval(() => {
            if (this.isMeasuring) { return; } // skip if last echo not yet received

            this.isMeasuring   = true;
            this.echoStartTick = null;

            // Send a 10 µs HIGH pulse to start a measurement
            this.usTrigger.trigger(10, 1);

            // Safety net: if no echo arrives within 60 ms (≈10 m round-trip),
            // assume the sensor is out of range and reset the measuring flag.
            this.measureTimeout = setTimeout(() => {
                this.measureTimeout  = null;
                this.isMeasuring     = false;
                this.echoStartTick   = null;
                this.sendSocketNotification("DISTANCE_MEASURED", { distance: 9999 });
            }, 60);

        }, this.config.ultrasonicInterval);
    },

    // ── Cleanup ────────────────────────────────────────────────────────────
    stop: function () {
        console.log("[MMM-WakeUpSensor] Stopping node helper.");

        if (this.measureInterval) {
            clearInterval(this.measureInterval);
            this.measureInterval = null;
        }
        if (this.measureTimeout) {
            clearTimeout(this.measureTimeout);
            this.measureTimeout = null;
        }

        // Release pigpio resources
        try {
            require("pigpio").terminate();
        } catch (e) {
            // pigpio may not have been loaded; ignore
        }

        this._resetState();
    }
});
