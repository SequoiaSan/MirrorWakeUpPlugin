#!/usr/bin/env python3
"""
hcsr04.py - HC-SR04 ultrasonic distance helper for MMM-WakeUpSensor.

Runs as a separate OS process spawned by node_helper.js, so that the
microsecond-precision GPIO work happens entirely outside of the
Electron/Node process. This avoids the "Module did not self-register"
class of native-binding failures that plague `pigpio` under Electron.

Prints one floating-point distance (in centimetres) per line, flushed
immediately, e.g.:

    42.7
    43.1
    9999

A value of 9999 represents "out of range / no echo" (matches the
sentinel the frontend already understands).

Usage:
    python3 hcsr04.py <trig_bcm> <echo_bcm> <interval_seconds>

Dependencies:
    gpiozero  (pre-installed on Raspberry Pi OS)
    A backing GPIO library, in priority order:
        - lgpio   (Pi 5, Pi OS Bookworm; pre-installed)
        - pigpio  (with pigpiod running; optional fallback)
        - RPi.GPIO (Pi <= 4 on older Pi OS; pre-installed)
    gpiozero auto-selects whichever is available.
"""

import sys
import time


def _eprint(msg):
    print(msg, file=sys.stderr, flush=True)


def main():
    if len(sys.argv) != 4:
        _eprint("usage: hcsr04.py <trig_bcm> <echo_bcm> <interval_seconds>")
        return 2

    try:
        trig = int(sys.argv[1])
        echo = int(sys.argv[2])
        interval = float(sys.argv[3])
    except ValueError as exc:
        _eprint("invalid argument: {}".format(exc))
        return 2

    if interval <= 0:
        _eprint("interval must be > 0")
        return 2

    try:
        # Import lazily so argument validation errors are reported even on
        # machines without gpiozero installed (e.g. CI).
        from gpiozero import DistanceSensor
    except ImportError as exc:
        _eprint("gpiozero not available: {}. "
                "Install with: sudo apt install python3-gpiozero".format(exc))
        return 1

    try:
        # max_distance is in metres. HC-SR04 spec tops out at ~4 m.
        sensor = DistanceSensor(echo=echo, trigger=trig, max_distance=4.0)
    except Exception as exc:  # noqa: BLE001 - surface any backend init error
        _eprint("failed to initialise HC-SR04 on TRIG={} ECHO={}: {}".format(
            trig, echo, exc))
        return 1

    try:
        while True:
            try:
                # gpiozero returns 0.0..1.0 of max_distance (metres).
                distance_cm = sensor.distance * 100.0
            except Exception as exc:  # noqa: BLE001
                # Transient read failure - report out-of-range, keep going.
                _eprint("read error: {}".format(exc))
                distance_cm = 9999.0

            # Treat "right at max_distance" or zero as out-of-range, matching
            # the sentinel the JS side already handles.
            if distance_cm <= 0.0 or distance_cm >= 399.0:
                distance_cm = 9999.0

            print("{:.2f}".format(distance_cm), flush=True)
            time.sleep(interval)
    except KeyboardInterrupt:
        return 0
    finally:
        try:
            sensor.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    sys.exit(main())
