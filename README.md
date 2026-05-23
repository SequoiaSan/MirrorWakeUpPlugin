# MMM-WakeUpSensor

A [MagicMirror²](https://magicmirror.builders/) module that wakes up your mirror display based on proximity:

| Sensor input | Display state | Overlay opacity | Widget visibility |
|---|---|---|---|
| Nobody detected | **AWAY** | 1.0 (black) | 0 % — hidden |
| PIR fires (motion nearby) | **NEARBY** | 0.8 | ~20 % |
| Ultrasonic ≤ presenceDistance | **PRESENT** | 0.0 (transparent) | 100 % |

All state changes use a smooth **fade-in / fade-out** effect.  
**Ultrasonic always wins over PIR.** While a person stands in front of the mirror the PIR signal is ignored.

---

## Hardware required

| Component | Purpose |
|---|---|
| PIR sensor (e.g. HC-SR501) | Detect motion in the room |
| Ultrasonic sensor HC-SR04 | Measure exact distance to a person |
| Raspberry Pi (any model with GPIO) | Host |
| 3.3 V ↔ 5 V voltage divider for ECHO pin | HC-SR04 ECHO outputs 5 V; Pi GPIO is 3.3 V |

### Wiring

```
Raspberry Pi 3.3V ──────────────────────── PIR VCC
Raspberry Pi GND  ──────────────────────── PIR GND
Raspberry Pi GPIO4  (BCM 4, pin 7) ──────── PIR OUT

Raspberry Pi 5V   ──────────────────────── HC-SR04 VCC
Raspberry Pi GND  ──────────────────────── HC-SR04 GND
Raspberry Pi GPIO23 (BCM 23, pin 16) ────── HC-SR04 TRIG
Raspberry Pi GPIO24 (BCM 24, pin 18) ←──── HC-SR04 ECHO
                                      │
                          1 kΩ resistor (ECHO → GPIO24)
                          2 kΩ resistor (ECHO → GND)
                          (voltage divider: 5 V → 3.3 V)
```

> **Important:** The HC-SR04 ECHO pin outputs **5 V**.  Always use a voltage divider (1 kΩ + 2 kΩ) or a logic-level shifter before connecting to the Pi.

---

## Installation

```bash
# 1. Clone into your MagicMirror modules folder
cd ~/MagicMirror/modules
git clone <this-repo-url> MMM-WakeUpSensor

# 2. Install dependencies
cd MMM-WakeUpSensor
npm install

# 3. pigpio requires access to /dev/mem – run MagicMirror with sudo
#    or add the pi user to the gpio group and configure pigpio accordingly.
```

---

## Configuration

Add the module to `~/MagicMirror/config/config.js`:

```js
{
    module:   "MMM-WakeUpSensor",
    position: "bottom_center",   // position doesn't matter; module renders nothing visible
    config: {
        pirPin:             4,     // BCM GPIO pin for PIR OUT
        trigPin:            23,    // BCM GPIO pin for HC-SR04 TRIG
        echoPin:            24,    // BCM GPIO pin for HC-SR04 ECHO
        presenceDistance:   150,   // cm — ultrasonic threshold to enter PRESENT state
        pirTimeout:         30000, // ms — how long NEARBY lasts after last PIR pulse
        ultrasonicTimeout:  3000,  // ms — grace period before leaving PRESENT state
        fadeDuration:       2000,  // ms — CSS opacity transition speed
        ultrasonicInterval: 1000,  // ms — how often the ultrasonic sensor is polled
        debug:              false  // show on-screen live sensor/state diagnostics
    }
}
```

### Config options

| Option | Default | Description |
|---|---|---|
| `pirPin` | `4` | BCM GPIO number for PIR signal output |
| `trigPin` | `23` | BCM GPIO number for HC-SR04 TRIG |
| `echoPin` | `24` | BCM GPIO number for HC-SR04 ECHO |
| `presenceDistance` | `150` | Distance in **cm** below which a person is "in front" of the mirror |
| `pirTimeout` | `30000` | Milliseconds the NEARBY state persists after the last PIR pulse |
| `ultrasonicTimeout` | `3000` | Milliseconds of no detection before leaving the PRESENT state |
| `fadeDuration` | `2000` | Duration of the CSS fade transition in milliseconds |
| `ultrasonicInterval` | `1000` | How often (ms) the ultrasonic sensor fires a measurement |
| `debug` | `false` | Show a small on-screen debug panel with current PIR status, ultrasonic distance, mirror state and overlay opacity |

---

## State machine

```
         PIR fires
  AWAY ──────────────► NEARBY
   ▲                      │
   │   pirTimeout          │  ultrasonic ≤ presenceDistance
   │   expires             ▼
   │               ┌──► PRESENT ◄──────────────────── (any state)
   │               │      │
   └───────────────┘      │  ultrasonicTimeout ms of no detection
    (no PIR active)        │
                           │  pirTimer still active → NEARBY
                           │  pirTimer expired      → AWAY
                           ▼
                        NEARBY / AWAY
```

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `pigpio not available` error | Run `npm install` inside the module folder |
| Mirror never wakes up | Check wiring; verify GPIO pin numbers (BCM numbering) |
| Distance readings erratic | Add decoupling capacitor (100 µF) across HC-SR04 VCC/GND; check voltage divider |
| PIR triggers too often | Adjust the PIR sensitivity potentiometer; increase `pirTimeout` |
| Overlay covers MagicMirror UI controls | Normal — `pointer-events: none` on the overlay preserves touch/click |

---

## License

MIT
