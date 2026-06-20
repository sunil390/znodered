# Presence Automation — Spec

## Overview

A Node-RED flow that uses an RD-03D mmWave radar sensor (via MQTT) to detect human presence, visualize target positions on a retro radar sweep dashboard, and control a smart plug via Alexa routines based on geofence zone entry/exit.

## Capabilities

### CAP-PA-01: Multi-Target Radar Tracking

- Subscribes to MQTT topic `home/radar/sensor/+/state`
- Tracks up to **3 simultaneous targets** (t1, t2, t3)
- Maintains x/y coordinates, distance, active state, and last update timestamp per target
- Calculates Euclidean distance from origin for each target
- Filters out invalid values (NaN, "unknown", empty strings)
- Ignores coordinate values ≤ 5mm (noise floor)

### CAP-PA-02: Presence State Machine

- **Auto-recovery**: If valid coordinate data arrives, presence is automatically set to `true`
- **Explicit presence**: Responds to `presence` or `target_detected` MQTT topics
- **Instant wipe**: When presence goes explicitly false, all target data resets immediately (x=0, y=0, active=false)
- **Sticky timeout**: Once "in zone", presence holds for 30 minutes even without new data (prevents false departures during stationary periods)

### CAP-PA-03: Geofence Zone Detection

- Defines a circular geofence of **2000mm (2 meters)** radius from origin
- Each target's `inZone` flag is set when `distance < GEOFENCE_LIMIT`
- Zone state change triggers the actuation pipeline (output 2)
- Output payload: `"on"` when any target enters zone, `"off"` when all targets leave zone

### CAP-PA-04: Smart Plug Control via Alexa

- **Arrival (on)**: Triggers Alexa routine to turn plug ON immediately
- **Departure (off)**: Starts a 10-second debounce timer before turning plug OFF
- **Cancellation**: If someone returns during the 10-second window, the OFF timer is cancelled via `msg.reset = true`
- Uses `alexa-remote-routine` nodes with specific routine ARNs and device IDs

### CAP-PA-05: Mobile Push Notifications via ntfy

- Sends push notifications to mobile devices on arrival and departure events
- Uses [ntfy.sh](https://ntfy.sh) service via HTTP POST to topic `zpi-Presence`
- **Arrival**: Notification fires immediately after Alexa plug ON routine completes
- **Departure**: Notification fires after the 10-second debounce (post Alexa plug OFF)
- Both notifications use Priority: High, Title: "Presence", Tags: "House"
- Arrival body: `Arrived — plug ON`
- Departure body: `departed — plug Off`

### CAP-PA-06: Live Radar Visualization

- Renders a retro-styled radar sweep on dashboard page `/radar`
- Half-circle (180°) sweep with animated rotation
- Displays target blips at their real x/y positions (scaled to canvas)
- Green phosphor aesthetic with fade trails
- Updates in real-time from function node output 1
- Canvas: 800×400px, responsive with aspect-ratio lock

## Constraints

| Constraint | Value |
|------------|-------|
| Max targets tracked | 3 |
| Geofence radius | 2000mm (2m) |
| Sticky timeout | 30 minutes (1,800,000ms) |
| Departure debounce | 10 seconds |
| Noise floor | ≤ 5mm (ignored) |
| MQTT QoS | 0 (fire-and-forget) |
| Dashboard page | `/radar` |
| Radar canvas size | 800×400 px |
| Max detection range | 6.0m (`maxRange` in visualization) |

## External Dependencies

| Dependency | Type | Location/Details |
|------------|------|------------------|
| RD-03D mmWave Radar | Hardware sensor | Publishes to MQTT via ESPHome/Zigbee |
| MQTT Broker | Service | `localhost:1883` |
| Alexa Account | Cloud service | Amazon, device ID `3493a9c7...` |
| Alexa Plug ON routine | Cloud routine | ARN `amzn1.alexa.automation.8a9ea390-...` |
| Alexa Plug OFF routine | Cloud routine | ARN `amzn1.alexa.automation.d75ddab9-...` |
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
