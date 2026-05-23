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

This module has **no Node native dependencies**. All GPIO work is
delegated to small external OS processes — `gpiomon` from `libgpiod`
for the PIR pin, and a tiny Python helper (`scripts/hcsr04.py`) using
`gpiozero` for the HC-SR04. That means there is nothing to rebuild
after a Node or Electron upgrade, and no more
`Module did not self-register` failures.

```bash
# 1. Clone into your MagicMirror modules folder
cd ~/MagicMirror/modules
git clone <this-repo-url> MMM-WakeUpSensor

# 2. Install the system tools the helpers use.
#    These are already present on stock Raspberry Pi OS, but install
#    explicitly to be safe:
sudo apt update
sudo apt install -y gpiod python3 python3-gpiozero

# 3. Make sure the user running MagicMirror is in the `gpio` group
#    (it usually already is on Pi OS):
sudo usermod -aG gpio "$USER"
#    Log out and back in for the group change to take effect.

# 4. (Optional) `npm install` — there are no runtime dependencies,
#    so this is a no-op, but it keeps tooling happy:
cd MMM-WakeUpSensor
npm install
```

> No `sudo` is required to run MagicMirror itself.  
> No `electron-rebuild` is required — there are no native modules.

---

## Configuration

Add the module to `~/MagicMirror/config/config.js`:

```js
{
    module:   "MMM-WakeUpSensor",
    position: "bottom_center",   // position doesn't matter; module renders nothing visible
    config: {
        pirPin:             4,     // BCM GPIO pin for PIR OUT
        pirChip:            "gpiochip0", // libgpiod chip name; "gpiochip4" on Pi 5
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
| `pirChip` | `"gpiochip0"` | libgpiod chip name passed to `gpiomon`. Use `"gpiochip4"` on Raspberry Pi 5 / Pi OS Bookworm. If left at the default, the helper will automatically retry with `gpiochip4` when `gpiochip0` is unavailable. |
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
| `Failed to spawn gpiomon` / `gpiomon exited unexpectedly` / `gpiomon: invalid argument -r` | The `gpiod` package is missing, the user running MagicMirror is not in the `gpio` group, or you have a very old plugin version that pre-dates libgpiod v2 support. Run `sudo apt install gpiod` and `sudo usermod -aG gpio "$USER"` (then log out / back in). On Raspberry Pi 5 set `pirChip: "gpiochip4"` in the module config. The helper auto-detects libgpiod v1 vs v2 and uses the matching `gpiomon` syntax. |
| `HC-SR04 helper exited unexpectedly` / `gpiozero not available` | Install the Python helper deps: `sudo apt install python3 python3-gpiozero`. Make sure the user can access GPIO (gpio group). |
| Mirror never wakes up | Check wiring; verify GPIO pin numbers (BCM numbering) |
| Distance readings erratic | Add decoupling capacitor (100 µF) across HC-SR04 VCC/GND; check voltage divider |
| PIR triggers too often | Adjust the PIR sensitivity potentiometer; increase `pirTimeout` |
| Overlay covers MagicMirror UI controls | Normal — `pointer-events: none` on the overlay preserves touch/click |

---

## License

MIT
