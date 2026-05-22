/**
 * MMM-WakeUpSensor
 *
 * MagicMirror² module that controls display visibility using a PIR sensor
 * (motion nearby) and an HC-SR04 ultrasonic distance sensor (person in front).
 *
 * State machine:
 *   AWAY    – nobody detected  → full-screen black overlay (opacity 1.0), widgets hidden
 *   NEARBY  – PIR fired        → overlay at 0.80 opacity, widgets visible at ~20%
 *   PRESENT – ultrasonic hit   → overlay at 0.0 opacity, widgets fully visible (100%)
 *
 * Ultrasonic always wins over PIR.  If PRESENT, PIR events are ignored.
 * When ultrasonic loses the person it waits `ultrasonicTimeout` ms before
 * downgrading; it returns to NEARBY (if PIR is still active) or AWAY.
 */

Module.register("MMM-WakeUpSensor", {

    // ── Default configuration ──────────────────────────────────────────────
    defaults: {
        pirPin:             4,     // BCM GPIO pin connected to PIR OUT
        trigPin:            23,    // BCM GPIO pin connected to HC-SR04 TRIG
        echoPin:            24,    // BCM GPIO pin connected to HC-SR04 ECHO
        presenceDistance:   150,   // cm – ultrasonic threshold (person "in front")
        pirTimeout:         30000, // ms – how long NEARBY lasts after last PIR pulse
        ultrasonicTimeout:  3000,  // ms – grace period before leaving PRESENT
        fadeDuration:       2000,  // ms – CSS opacity transition duration
        ultrasonicInterval: 1000   // ms – how often to fire the ultrasonic trigger
    },

    // ── Lifecycle ──────────────────────────────────────────────────────────
    start: function () {
        Log.info(this.name + ": Starting.");
        this.state          = "AWAY";
        this.pirTimer       = null;   // timeout handle for PIR activity window
        this.ultrasonicTimer = null;  // timeout handle for PRESENT → downgrade
        this.overlay        = null;

        // Send configuration to node_helper as soon as possible so GPIO
        // initialisation can begin while MagicMirror renders the DOM.
        this.sendSocketNotification("CONFIG", this.config);
    },

    // Called by MagicMirror² once all module DOM nodes exist.
    notificationReceived: function (notification) {
        if (notification === "DOM_OBJECTS_CREATED") {
            this._createOverlay();
        }
    },

    // ── Overlay ────────────────────────────────────────────────────────────
    /**
     * Inject a full-screen black div *above* all other content.
     * Fading its opacity up/down produces the widget dimming effect
     * without touching individual module DOM trees.
     */
    _createOverlay: function () {
        var overlay = document.createElement("div");
        overlay.id  = "MMM-WakeUpSensor-overlay";

        // The transition duration comes from config so set it inline.
        overlay.style.transition = "opacity " + this.config.fadeDuration + "ms ease-in-out";

        document.body.appendChild(overlay);
        this.overlay = overlay;

        // Apply initial state (AWAY → fully black).
        this._applyState();
    },

    // ── State helpers ──────────────────────────────────────────────────────
    _applyState: function () {
        if (!this.overlay) { return; }

        var opacityMap = {
            AWAY:    "1",    // overlay fully opaque  → widgets invisible
            NEARBY:  "0.8",  // overlay 80% opaque    → widgets ~20% visible
            PRESENT: "0"     // overlay transparent   → widgets 100% visible
        };

        this.overlay.style.opacity = opacityMap[this.state] || "1";
        Log.info(this.name + ": State → " + this.state +
                 " (overlay opacity " + this.overlay.style.opacity + ")");
    },

    // ── Socket notifications from node_helper ──────────────────────────────
    socketNotificationReceived: function (notification, payload) {
        switch (notification) {
            case "PIR_DETECTED":
                this._onPirDetected();
                break;
            case "DISTANCE_MEASURED":
                this._onDistanceMeasured(payload.distance);
                break;
            case "SENSOR_ERROR":
                Log.error(this.name + ": Sensor error – " + payload.error);
                break;
        }
    },

    // ── PIR handler ────────────────────────────────────────────────────────
    _onPirDetected: function () {
        // Ultrasonic takes full priority: ignore PIR while a person is confirmed.
        if (this.state !== "PRESENT") {
            this.state = "NEARBY";
            this._applyState();
        }

        // Extend (or start) the PIR activity window.
        if (this.pirTimer) { clearTimeout(this.pirTimer); }

        var self = this;
        this.pirTimer = setTimeout(function () {
            self.pirTimer = null;
            // Only downgrade if we haven't been promoted to PRESENT.
            if (self.state === "NEARBY") {
                self.state = "AWAY";
                self._applyState();
            }
        }, this.config.pirTimeout);
    },

    // ── Ultrasonic handler ─────────────────────────────────────────────────
    _onDistanceMeasured: function (distance) {
        var withinRange = (
            distance !== null &&
            distance > 0 &&
            distance <= this.config.presenceDistance
        );

        if (withinRange) {
            // ── Person detected in front of mirror ──
            // Cancel any pending downgrade timer.
            if (this.ultrasonicTimer) {
                clearTimeout(this.ultrasonicTimer);
                this.ultrasonicTimer = null;
            }

            if (this.state !== "PRESENT") {
                this.state = "PRESENT";
                this._applyState();
            }

        } else {
            // ── Person not (or no longer) in front ──
            // Only react if we are currently in PRESENT state and no downgrade
            // is already pending.
            if (this.state === "PRESENT" && !this.ultrasonicTimer) {
                var self = this;
                this.ultrasonicTimer = setTimeout(function () {
                    self.ultrasonicTimer = null;
                    // Confirm we're still PRESENT (could have changed externally).
                    if (self.state === "PRESENT") {
                        // Fall back to NEARBY if PIR is still active, else AWAY.
                        self.state = self.pirTimer ? "NEARBY" : "AWAY";
                        self._applyState();
                    }
                }, this.config.ultrasonicTimeout);
            }
        }
    },

    // ── Required getDom – module renders nothing visible itself ────────────
    getDom: function () {
        return document.createElement("div");
    }
});
