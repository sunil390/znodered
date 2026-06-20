# Presence Automation — Spec

## Overview

A Node-RED flow that uses an RD-03D mmWave radar sensor (via ESP32-S3 + ESPHome over MQTT) to detect human presence, visualize target positions on a retro radar sweep dashboard, and control a smart plug via Alexa based on geofence zone entry/exit.

## Capabilities

### CAP-PA-01: Multi-Target Radar Tracking

- Subscribes to MQTT topics under `home/radar/+/+/state` (matches both `sensor/` and `binary_sensor/` paths)
- Tracks up to **3 simultaneous targets** (t1, t2, t3)
- Maintains x/y coordinates (mm), distance, active state, inZone flag, and lastUpdate timestamp per target
- Calculates Euclidean distance from origin for each target
- Filters out invalid values (NaN, "unknown", empty strings)
- Ignores coordinate values ≤ 5mm (noise floor)
- Passes raw coordinates to UI — all visual smoothing handled client-side via lerp

### CAP-PA-02: Presence State Machine

- **Auto-recovery**: If valid coordinate data arrives (>5mm), presence is set to `true` immediately
- **Explicit ON**: `target_detected` = ON sets presence true and resets `presenceOffSince` timestamp
- **Explicit OFF**: `target_detected` = OFF records a timestamp (no immediate action — departure handled by target_count duration in step 3b)
- **Target count reset**: `target_count > 0` resets departure timer (`targetCountZeroSince = 0`)
- **Departure via timeout**: After 4 continuous minutes of `target_count = 0`, presence is set to false and Alexa turns off
- **Sticky timeout**: Targets hold position for 30 minutes without new data if presence is still confirmed

> **Note**: The RD-03D is Doppler-only — `target_detected` mirrors `target_count` (both go OFF when sitting still). Departure relies on `target_count = 0` duration with long timeouts so that micro-movements (every 5-90s) reset the timer.

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

- **SPOT_HOLD** (2 min): Spots clear after 2 minutes of continuous `target_count = 0`
- **ALEXA_OFF** (4 min): Presence set to false and Alexa turns off after 4 minutes of continuous `target_count = 0`
- Sitting still keeps spots visible because micro-movements (breathing, fidgeting) produce count > 0 spikes every 5-90s, resetting the timer
- After Alexa off, auto-recovery is blocked until real `target_count > 0` returns
- Clear messages are sent continuously (not just once) so the UI stays in sync even if a WebSocket message is missed

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
| Spot hold timer | 2 minutes (120,000ms) |
| Alexa off timeout | 4 minutes (240,000ms) |
| Sticky timeout | 30 minutes (1,800,000ms) |
| Noise floor | ≤ 5mm (ignored) |
| Radar FOV | 120° (±60°) |
| Max display range | 3.5m |
| MQTT QoS | 0 (fire-and-forget) |
| MQTT subscription | `home/radar/+/+/state` |
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
