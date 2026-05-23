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
        ultrasonicInterval: 1000,  // ms – how often to fire the ultrasonic trigger
        debug:              false   // show sensor/state debug panel on screen
    },

    // ── Styles ─────────────────────────────────────────────────────────────
    getStyles: function () {
        return ["MMM-WakeUpSensor.css"];
    },

    // ── Lifecycle ──────────────────────────────────────────────────────────
    start: function () {
        Log.info(this.name + ": Starting.");
        this.state          = "AWAY";
        this.pirTimer       = null;   // timeout handle for PIR activity window
        this.ultrasonicTimer = null;  // timeout handle for PRESENT → downgrade
        this.overlay        = null;
        this.debugPanel     = null;
        this._setupTimer    = null;   // periodic self-heal interval
        this._debugLogTimer = null;   // periodic console snapshot interval
        this.debugInfo      = {
            lastPirAt:      null,
            lastDistance:   null,
            lastSensorError: null
        };

        if (this.config.debug) {
            Log.info(this.name + ": Debug mode ENABLED – on-screen debug panel will be shown.");
        }

        // Send configuration to node_helper as soon as possible so GPIO
        // initialisation can begin while MagicMirror renders the DOM.
        this.sendSocketNotification("CONFIG", this.config);

        // Fallback: attempt to create overlay/debug panel shortly after start
        // in case DOM_OBJECTS_CREATED has already fired or doesn't reach us
        // (some MagicMirror loading orders / module reloads can drop it).
        // _createOverlay / _createDebugPanel are idempotent.
        var self = this;
        var trySetup = function () {
            self._ensureElements();
        };
        if (document.readyState === "complete" || document.readyState === "interactive") {
            setTimeout(trySetup, 0);
        } else {
            window.addEventListener("DOMContentLoaded", trySetup, { once: true });
        }

        // Self-healing watchdog: every 1 s, verify the overlay (and debug
        // panel, when enabled) are still attached to the document. If another
        // module's DOM mutation, a router/page change, or a stylesheet hide
        // has removed or hidden them, re-create them. This makes the panel
        // virtually impossible to lose at runtime.
        this._setupTimer = setInterval(function () {
            self._ensureElements();
        }, 1000);

        // Periodic console snapshot so the user can verify the module is
        // alive even when – for any reason – the on-screen panel is not
        // visible. Only active when debug is enabled.
        if (this.config.debug) {
            this._debugLogTimer = setInterval(function () {
                Log.info(self.name + " [debug snapshot]: " +
                         JSON.stringify({
                             state:    self.state,
                             opacity:  self.overlay ? self.overlay.style.opacity : null,
                             panelAttached: !!(self.debugPanel && self.debugPanel.isConnected),
                             overlayAttached: !!(self.overlay && self.overlay.isConnected),
                             lastDistance: self.debugInfo.lastDistance,
                             lastPirAt:    self.debugInfo.lastPirAt,
                             lastSensorError: self.debugInfo.lastSensorError
                         }));
            }, 5000);
        }
    },

    // Called by MagicMirror² at various lifecycle points. We treat every
    // DOM-related notification as another opportunity to (re)create our
    // elements, since timing of these events varies across MM versions.
    notificationReceived: function (notification) {
        if (notification === "DOM_OBJECTS_CREATED" ||
            notification === "MODULE_DOM_CREATED" ||
            notification === "ALL_MODULES_STARTED") {
            this._ensureElements();
        }
    },

    // Idempotent helper that (re)creates the overlay and, when debug is
    // enabled, the debug panel. Safe to call any number of times; only acts
    // when an element is missing or has been detached from the document.
    _ensureElements: function () {
        if (!document.body) { return; }

        if (!this.overlay || !this.overlay.isConnected) {
            this.overlay = null;
            this._createOverlay();
        }
        if (this.config.debug) {
            if (!this.debugPanel || !this.debugPanel.isConnected) {
                this.debugPanel = null;
                this._createDebugPanel();
            }
        }
    },

    // ── Overlay ────────────────────────────────────────────────────────────
    /**
     * Inject a full-screen black div *above* all other content.
     * Fading its opacity up/down produces the widget dimming effect
     * without touching individual module DOM trees.
     */
    _createOverlay: function () {
        if (this.overlay) { return; }
        if (!document.body) { return; }

        var overlay = document.createElement("div");
        overlay.id  = "MMM-WakeUpSensor-overlay";

        // Inline fallback styles so the overlay also works if the
        // accompanying CSS file fails to load for any reason. Use
        // setProperty(..., "important") so these cannot be overridden
        // by another module's stylesheet.
        var setImp = function (prop, value) {
            overlay.style.setProperty(prop, value, "important");
        };
        setImp("position",         "fixed");
        setImp("top",              "0");
        setImp("left",             "0");
        setImp("width",            "100%");
        setImp("height",           "100%");
        setImp("background-color", "#000000");
        setImp("opacity",          "1");
        setImp("z-index",          "9998");
        setImp("pointer-events",   "none");
        setImp("display",          "block");
        setImp("visibility",       "visible");

        // The transition duration comes from config so set it inline.
        setImp("transition", "opacity " + this.config.fadeDuration + "ms ease-in-out");

        document.body.appendChild(overlay);
        this.overlay = overlay;

        // Apply initial state (AWAY → fully black).
        this._applyState();
    },

    _createDebugPanel: function () {
        if (this.debugPanel) { return; }
        if (!document.body) { return; }

        var panel = document.createElement("div");
        panel.id = "MMM-WakeUpSensor-debug";

        // Inline fallback styles so the panel is visible even if
        // MMM-WakeUpSensor.css fails to load (cached old install, wrong
        // module folder name, 404, etc.) and stays above the overlay
        // even if other modules use high z-index values. Use
        // setProperty(..., "important") so no other stylesheet can
        // hide or restyle the panel.
        var setImp = function (prop, value) {
            panel.style.setProperty(prop, value, "important");
        };
        setImp("position",         "fixed");
        setImp("top",              "20px");
        setImp("left",             "20px");
        setImp("z-index",          "2147483647"); // max signed 32-bit int
        setImp("pointer-events",   "none");
        setImp("padding",          "10px 12px");
        setImp("border",           "2px solid #ffeb3b"); // bright yellow, hard to miss
        setImp("border-radius",    "6px");
        setImp("background-color", "rgba(0, 0, 0, 0.85)");
        setImp("color",            "#ffffff");
        setImp("font-size",        "14px");
        setImp("line-height",      "1.35");
        setImp("font-family",      "monospace");
        setImp("display",          "block");
        setImp("visibility",       "visible");
        setImp("opacity",          "1");
        setImp("max-width",        "90vw");
        setImp("min-width",        "200px");
        setImp("white-space",      "pre");

        document.body.appendChild(panel);
        this.debugPanel = panel;

        Log.info(this.name + ": Debug panel created and attached to <body>.");

        this._updateDebugPanel();
    },

    _updateDebugPanel: function () {
        if (!this.config.debug || !this.debugPanel) { return; }

        var distanceText = "n/a";
        if (typeof this.debugInfo.lastDistance === "number") {
            distanceText = (Math.round(this.debugInfo.lastDistance * 10) / 10) + " cm";
        }

        var pirLastSeen = "never";
        if (this.debugInfo.lastPirAt) {
            pirLastSeen = new Date(this.debugInfo.lastPirAt).toLocaleTimeString();
        }

        var lines = [
            "WakeUpSensor Debug",
            "State: " + this.state,
            "Overlay opacity: " + (this.overlay ? this.overlay.style.opacity : "n/a"),
            "PIR timer: " + (this.pirTimer ? "active" : "idle"),
            "PIR last trigger: " + pirLastSeen,
            "Ultrasonic distance: " + distanceText
        ];

        if (this.debugInfo.lastSensorError) {
            lines.push("Sensor error: " + this.debugInfo.lastSensorError);
        }

        // Use textContent (not innerHTML) so any text coming from the
        // node_helper (e.g. sensor error messages) cannot inject HTML.
        // The panel is styled with `white-space: pre`, so `\n` produces
        // real line breaks.
        this.debugPanel.textContent = lines.join("\n");
    },

    // ── State helpers ──────────────────────────────────────────────────────
    _applyState: function () {
        if (!this.overlay) { return; }

        var opacityMap = {
            AWAY:    "1",    // overlay fully opaque  → widgets invisible
            NEARBY:  "0.8",  // overlay 80% opaque    → widgets ~20% visible
            PRESENT: "0"     // overlay transparent   → widgets 100% visible
        };

        var op = opacityMap[this.state] || "1";
        this.overlay.style.setProperty("opacity", op, "important");
        Log.info(this.name + ": State → " + this.state +
                 " (overlay opacity " + op + ")");
        this._updateDebugPanel();
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
                this.debugInfo.lastSensorError = payload.error;
                this._updateDebugPanel();
                break;
        }
    },

    // ── PIR handler ────────────────────────────────────────────────────────
    _onPirDetected: function () {
        this.debugInfo.lastPirAt = Date.now();

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
            self._updateDebugPanel();
        }, this.config.pirTimeout);
        this._updateDebugPanel();
    },

    // ── Ultrasonic handler ─────────────────────────────────────────────────
    _onDistanceMeasured: function (distance) {
        this.debugInfo.lastDistance = distance;

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
                    self._updateDebugPanel();
                }, this.config.ultrasonicTimeout);
            }
        }

        this._updateDebugPanel();
    },

    // ── Required getDom – module renders nothing visible itself ────────────
    getDom: function () {
        return document.createElement("div");
    },

    // ── Cleanup ────────────────────────────────────────────────────────────
    // Stop both watchdog timers if MagicMirror tears the module down (e.g.
    // module reload). Without this, the intervals would keep running and
    // accumulate after every reload.
    suspend: function () {
        // suspend is called when the module is hidden; keep timers running
        // so the panel re-appears when MagicMirror un-hides us.
    },

    _clearTimers: function () {
        if (this._setupTimer)    { clearInterval(this._setupTimer);    this._setupTimer    = null; }
        if (this._debugLogTimer) { clearInterval(this._debugLogTimer); this._debugLogTimer = null; }
        if (this.pirTimer)        { clearTimeout(this.pirTimer);        this.pirTimer        = null; }
        if (this.ultrasonicTimer) { clearTimeout(this.ultrasonicTimer); this.ultrasonicTimer = null; }
    }
});
