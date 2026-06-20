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

RD-03D mmWave radar detects room presence and controls a smart plug via Alexa routines.

- Tracks up to 3 targets via MQTT (`home/radar/sensor/+/state`)
- 2-meter geofence triggers plug on/off with 10-second departure debounce
- 30-minute sticky timeout prevents false departures when stationary
- Live retro radar sweep visualization on `/radar` dashboard page

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

## Hardware

- Raspberry Pi (runtime host)
- BBC Micro:bit (BLE paired for text display)
- RD-03D mmWave radar (presence sensor via MQTT)
- Alexa-controlled smart plug

## Specs

Detailed specifications and design documents live in [`openspec/specs/`](openspec/specs/):

- [`microbit-messaging/spec.md`](openspec/specs/microbit-messaging/spec.md) — capabilities, constraints, dependencies
- [`microbit-messaging/design.md`](openspec/specs/microbit-messaging/design.md) — architecture, design decisions, data flow
- [`presence-automation/spec.md`](openspec/specs/presence-automation/spec.md) — capabilities, state model, constraints
- [`presence-automation/design.md`](openspec/specs/presence-automation/design.md) — architecture, state machine, MQTT topics