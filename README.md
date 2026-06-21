# znodered

Node-RED flows for home automation running on a Raspberry Pi. Two flows, one dashboard.

## Flows

### Microbit Messaging

Send scrolling text to a BBC Micro:bit over Bluetooth — from the dashboard UI or via HTTP API.

- Dashboard text input with Send/Stop controls (`/dashboard`)
- `POST /microbit` endpoint for external integrations (n8n, Home Assistant)
- Rate-limited to 1 msg per 5 seconds to protect the BLE link
- Calls `python3 /home/zpi/node-scripts/send_text.py` for BLE transmission

### Presence Automation

RD-03D mmWave radar detects room presence and controls a smart plug via Alexa.

- ESP32-S3 DevKitC-1 + RD-03D radar via ESPHome (UART 256000 baud, MQTT to `192.168.2.251`)
- Tracks up to 3 targets via MQTT (`home/radar/+/+/state` — covers `sensor/` and `binary_sensor/`)
- 2-meter geofence with 100mm hysteresis band (enter ≤2000mm, exit ≥2100mm)
- **Geofence-only power control** — Alexa powers on only when a target enters the 2m perimeter
- ID-swap resilient: 10s staleness expiry with excess-slot guard (handles radar target reassignment)
- Stillness-safe: stale targets preserved when all slots are quiet (Doppler can't see stationary targets)
- 2-minute spot hold before clearing display (micro-movements reset timer)
- 4-minute timeout before Alexa off (extra safety margin for lights)
- Mobile push notifications via [ntfy.sh](https://ntfy.sh) on arrival/departure
- Live 120° retro radar sweep visualization on `/radar` dashboard page

## Dashboard

Base URL: `http://<pi-ip>:1880/dashboard`

| Page | Path | Description |
|------|------|-------------|
| Micro:bit | `/dashboard` | Message input, send/stop controls |
| Radar | `/radar` | Live radar sweep canvas |

Theme: **znext** (orange surface, blue primary)

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@flowfuse/node-red-dashboard` | 1.30.2 | Dashboard 2.0 UI |
| `node-red-contrib-alexa-remote2-applestrudel` | 5.0.59 | Alexa routine control |

## Services

| Service | Purpose |
|---------|--------|
| ntfy.sh | Mobile push notifications (`zpi-Presence` topic) |

## Hardware

- Raspberry Pi (runtime host)
- BBC Micro:bit (BLE paired for text display)
- ESP32-S3 DevKitC-1 (UART bridge to radar, WiFi to MQTT)
- RD-03D mmWave radar (Ai-Thinker 24GHz FMCW, 120° FOV, 5V power, 3.3V UART)
- Alexa-controlled smart plug

## Specs

Detailed specifications and design documents live in [`openspec/specs/`](openspec/specs/):

- [`microbit-messaging/spec.md`](openspec/specs/microbit-messaging/spec.md) — capabilities, constraints, dependencies
- [`microbit-messaging/design.md`](openspec/specs/microbit-messaging/design.md) — architecture, design decisions, data flow
- [`presence-automation/spec.md`](openspec/specs/presence-automation/spec.md) — capabilities, state model, constraints
- [`presence-automation/design.md`](openspec/specs/presence-automation/design.md) — architecture, state machine, MQTT topics

## Lessons Learned — RD-03D Radar

### Power supply matters more than code

Switching the ESP32 mini from a shared USB port to a **dedicated powerbank** resolved two major issues:
1. **Multi-target detection became reliable** — clean 5V DC eliminates switching noise that was degrading the 24GHz FMCW signal-to-noise ratio. The radar couldn't discriminate multiple return signals through the noise floor.
2. **Spot movements became smooth** — less phase noise on the chirps produces more stable x/y coordinates, reducing jitter that even client-side lerp couldn't fully mask.

> **Tip**: Enable "low-power-draw mode" on the powerbank (long-press the button). The ESP32 idles at ~40-80mA which is below most powerbanks' auto-shutoff threshold (~100-200mA). Without this mode, the powerbank will cut power after 10-30s thinking nothing is connected.

### Doppler radar can't see stationary targets

The RD-03D relies on Doppler shift — a person sitting perfectly still produces no coordinate updates AND `target_count` drops to 0. This means:
- You cannot use `target_count` or coordinate freshness alone to determine if someone left
- Departure must be timeout-based (4 min of sustained `target_count=0`) because micro-movements (breathing, fidgeting) produce spikes every 5-90s that reset the timer

### Target IDs are unstable

When a second person enters or leaves, the radar frequently **swaps target IDs** (t1 becomes t2 and vice versa). Naively clearing "excess" targets by slot number (e.g., "count=1 so clear t2") kills the real person's tracking data after a swap.

**Solution**: Only expire a stale slot when another slot is actively receiving fresh coordinates (proving it's a swap, not stillness). Expire the stalest slot first.

### Geofence-only triggering prevents false activations

Using `presence` alone to control the smart plug caused false power-ons when walking past the room (detected at >2m). Requiring a target within the 2m geofence ensures power-on only when someone enters the working area.