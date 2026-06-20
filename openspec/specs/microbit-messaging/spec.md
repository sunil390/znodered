# Microbit Messaging — Spec

## Overview

A Node-RED flow that sends scrolling text messages to a BBC Micro:bit over Bluetooth, with two entry points: a dashboard UI and an HTTP API.

## Capabilities

### CAP-MB-01: Dashboard Text Input

- User enters a message in a text input field on the `/dashboard` page
- Message is stored in `flow.saved_message` on submit (blur, enter, or delay)
- Stored message persists until overwritten

### CAP-MB-02: Dashboard Send/Stop Controls

- **Send Message** button retrieves `flow.saved_message` and forwards to the Bluetooth pipeline
- **STOP Scrolling** button sends the literal payload `[STOP]` to halt the Micro:bit display
- Both buttons feed into the same rate-limited pipeline

### CAP-MB-03: HTTP API Endpoint

- `POST /microbit` accepts JSON body with a `text` field
- Extracts `payload.text` and forwards to the Bluetooth pipeline
- Immediately returns HTTP 200 (fire-and-forget)
- Enables external systems (n8n, Home Assistant, scripts) to trigger messages

### CAP-MB-04: Rate Limiting

- Messages are rate-limited to **1 per 5 seconds** (drop mode)
- Prevents Bluetooth serial spam that would crash the Micro:bit connection
- Both UI and API paths share the same rate limiter

### CAP-MB-05: Bluetooth Transmission

- Executes `python3 /home/zpi/node-scripts/send_text.py <message>`
- Script handles BLE connection, UART service write, and disconnection
- stdout/stderr captured to debug sidebar

## Constraints

| Constraint | Value |
|------------|-------|
| Max message rate | 1 msg / 5 seconds |
| Transport | Bluetooth Low Energy (UART service) |
| Runtime host | Raspberry Pi (`/home/zpi/`) |
| Special payload | `[STOP]` — halts scrolling |
| Dashboard base path | `/dashboard` |
| UI group | "Micro:bit Messaging Control" |

## External Dependencies

| Dependency | Type | Location |
|------------|------|----------|
| `send_text.py` | Python BLE script | `/home/zpi/node-scripts/send_text.py` |
| BBC Micro:bit | Hardware | Paired via BLE to the Pi |
| Node-RED Dashboard 2.0 | npm package | `@flowfuse/node-red-dashboard` |

## Non-Functional Requirements

- Must tolerate Micro:bit being out of range (script exits with error, no crash)
- Dashboard must be responsive (3/6/9/12 column breakpoints)
- HTTP endpoint must not block on BLE transmission (async fire-and-forget)
