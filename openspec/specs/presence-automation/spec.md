# Presence Automation — Spec

## Overview

A Node-RED flow that uses an RD-03D mmWave radar sensor (via ESP32-S3 + ESPHome over MQTT) to detect human presence, visualize target positions on a retro radar sweep dashboard, and control a smart plug via Alexa based on geofence zone entry/exit.

## Capabilities

### CAP-PA-01: Multi-Target Radar Tracking

- Subscribes to MQTT topics under `home/radar/sensor/+/state`
- Tracks up to **3 simultaneous targets** (t1, t2, t3)
- Maintains x/y coordinates (mm), distance, active state, inZone flag, and lastUpdate timestamp per target
- Calculates Euclidean distance from origin for each target
- Filters out invalid values (NaN, "unknown", empty strings)
- Ignores coordinate values ≤ 5mm (noise floor)
- Passes raw coordinates to UI — all visual smoothing handled client-side via lerp

### CAP-PA-02: Presence State Machine

- **Auto-recovery**: If valid coordinate data arrives (>5mm) and no grace period is active, presence is set to `true`
- **Explicit ON**: `target_detected` = ON immediately sets presence true and cancels any grace period
- **Grace period**: `target_detected` = OFF starts a 60-second timer. Only after 60s of continuous OFF is presence set to `false` (prevents flicker from radar dropouts)
- **Target count unblock**: `target_count > 0` resets all pending timers and unblocks auto-recovery
- **Force-off**: After 5 continuous minutes of `target_count = 0`, presence is forced off regardless of `target_detected` state (handles stuck sensors)
- **Sticky timeout**: Targets hold position for 30 minutes without new data if presence is still confirmed

### CAP-PA-03: Geofence Zone Detection with Hysteresis

- **Enter threshold**: Target enters zone when distance ≤ 2000mm (2m)
- **Exit threshold**: Target leaves zone when distance ≥ 2100mm (100mm hysteresis band)
- Prevents rapid on/off toggling when target hovers near the boundary
- `occupied` = presence OR any target inZone (presence is authoritative)

### CAP-PA-04: Smart Plug Control via Alexa

- **Output 2** emits `"on"` or `"off"` when `occupied` state transitions
- Driven by the composite `occupied` flag (presence-aware, not just geofence)
- No downstream debounce needed — presence grace period + force-off provide timing control

### CAP-PA-05: Spot Clearing Logic

- **SPOT_HOLD** (10s): Spots clear after 10 seconds of `target_count = 0`, but only if `target_detected` is already OFF
- Sitting still keeps spots visible because `target_detected` remains ON
- **Force-off** (5 min): Clears all spots and forces presence off after 5 minutes of `target_count = 0`
- After force-off, auto-recovery is blocked until `target_count > 0` returns (prevents stale coordinate re-enable)

### CAP-PA-06: Live Radar Visualization

- Renders a retro-styled radar sweep on dashboard page `/radar`
- **120° arc** matching the RD-03D's actual scanning field of view (±60° from center)
- Animated sweep arm rotating within the 120° cone
- Displays target blips at real x/y positions with client-side lerp interpolation
- Green phosphor aesthetic with slow fade trails
- Grid rings at 1m intervals, cross rays at 30° intervals
- Outer boundary arc at max range
- Canvas: 800×400px, responsive with aspect-ratio lock

## Constraints

| Constraint | Value |
|------------|-------|
| Max targets tracked | 3 |
| Geofence enter radius | 2000mm (2m) |
| Geofence exit radius | 2100mm (hysteresis) |
| Presence grace period | 60 seconds |
| Force-off timeout | 5 minutes (300,000ms) |
| Spot hold timer | 10 seconds |
| Sticky timeout | 30 minutes (1,800,000ms) |
| Noise floor | ≤ 5mm (ignored) |
| Radar FOV | 120° (±60°) |
| Max display range | 3.5m |
| MQTT QoS | 0 (fire-and-forget) |
| Dashboard page | `/radar` |
| Radar canvas size | 800×400 px |
| UI lerp ease | 0.06 per frame (60fps) |

## Hardware

| Component | Details |
|-----------|---------|
| RD-03D mmWave Radar | Ai-Thinker 24GHz FMCW, 120° FOV, multi-target mode |
| ESP32-S3 DevKitC-1 | UART bridge: GPIO44=TX, GPIO43=RX, 256000 baud |
| Power | Radar requires 5V (UART logic at 3.3V) |

## External Dependencies

| Dependency | Type | Location/Details |
|------------|------|------------------|
| MQTT Broker | Service | `192.168.2.251:1883` |
| ESP32-S3 + ESPHome | Firmware | rd03d component, tracking_mode: multi, WiFi: AX55 |
| Alexa Account | Cloud service | Amazon, smart plug control |
| ntfy.sh | Push notifications | Topic: `zpi-Presence` |

## Known Limitations

- **RD-03D detects only moving targets** — relies on Doppler shift, cannot track truly stationary persons
- **Bursty detection pattern** — radar produces data in short bursts (3-7 readings at 20Hz) separated by 0.3-3s gaps of NaN
- **Target ID instability** — radar may reassign target IDs between bursts, causing position jumps
- **Single person practical limit** — multi-target mode rarely tracks multiple distinct targets due to FMCW limitations
| Node-RED Dashboard 2.0 | npm package | `@flowfuse/node-red-dashboard` |
| `node-red-contrib-alexa-remote2` | npm package | Alexa integration |
| ntfy.sh | Cloud service | `https://ntfy.sh/zpi-Presence` (push notifications) |

## State Model

```
┌─────────────────────────────────────────────────────────────┐
│  flow.radarMap                                              │
├─────────────────────────────────────────────────────────────┤
│  t1: { x, y, active, distance, lastUpdate, inZone }        │
│  t2: { x, y, active, distance, lastUpdate, inZone }        │
│  t3: { x, y, active, distance, lastUpdate, inZone }        │
│  presence: boolean                                          │
│  anyActive: boolean                                         │
└─────────────────────────────────────────────────────────────┘
```

## Non-Functional Requirements

- Must handle rapid MQTT messages (radar updates at ~10Hz) without backpressure
- Radar visualization must maintain smooth 60fps animation independent of data rate
- Alexa routine calls must be idempotent (calling "plug on" when already on is harmless)
- System must recover gracefully from MQTT broker restarts (auto-reconnect)
- Dashboard canvas must work on mobile browsers (responsive layout)
