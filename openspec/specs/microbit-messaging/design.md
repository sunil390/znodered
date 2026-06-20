# Microbit Messaging — Design

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Node-RED (Raspberry Pi)                                            │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Entry Points                                                │    │
│  │                                                             │    │
│  │  Dashboard UI (/dashboard)       HTTP API                   │    │
│  │  ┌────────────────────────┐      ┌──────────────┐          │    │
│  │  │ Text Input → Save      │      │ POST /microbit│          │    │
│  │  │ Send Btn  → Load       │      │ → Extract .text│         │    │
│  │  │ Stop Btn  → "[STOP]"   │      │ → HTTP 200    │          │    │
│  │  └────────────┬───────────┘      └──────┬───────┘          │    │
│  │               │                          │                  │    │
│  └───────────────┼──────────────────────────┼──────────────────┘    │
│                  │                          │                       │
│                  ▼                          ▼                       │
│          ┌──────────────────────────────────────┐                   │
│          │ Rate Limiter (1 msg / 5s, drop mode) │                   │
│          └──────────────────┬───────────────────┘                   │
│                             │                                       │
│                             ▼                                       │
│          ┌──────────────────────────────────────┐                   │
│          │ exec: python3 send_text.py <payload> │                   │
│          └──────────────────┬───────────────────┘                   │
│                             │                                       │
└─────────────────────────────┼───────────────────────────────────────┘
                              │ BLE UART
                              ▼
                    ┌──────────────────┐
                    │  BBC Micro:bit   │
                    │  LED Matrix      │
                    └──────────────────┘
```

## Design Decisions

### DD-01: Flow variable for message state

**Decision**: Store the entered text in `flow.saved_message` rather than passing directly through wires.

**Rationale**: Decouples text entry from send action. User types once, sends many times. The "Send" button reads the stored value, so rapid re-sends don't require re-typing.

### DD-02: Rate limiter in drop mode

**Decision**: Use a `delay` node in rate-limit mode (1/5s) with `drop: true`.

**Rationale**: BLE UART has limited throughput. If messages queue up, the Micro:bit connection becomes unstable. Dropping excess messages is preferable to queuing — the user sees the latest message rather than a stale backlog.

### DD-03: Shared pipeline for UI and API

**Decision**: Both the dashboard buttons and HTTP endpoint feed into the same rate limiter → exec chain.

**Rationale**: Single point of enforcement for rate limiting. Prevents API callers from bypassing the BLE protection.

### DD-04: exec node (not MQTT or serial)

**Decision**: Shell out to a Python script rather than using a Node-RED serial/BLE node.

**Rationale**: The `bleak` Python library provides more reliable BLE UART handling than available Node-RED BLE nodes. The exec approach also allows the script to be tested independently.

### DD-05: `[STOP]` as in-band signal

**Decision**: The stop command is a special string payload `[STOP]` sent through the same pipeline.

**Rationale**: The Python script (or Micro:bit firmware) recognizes this sentinel value and halts scrolling. Using the same path means it's also rate-limited, preventing spam of stop commands.

## Data Flow

```
msg.payload lifecycle:

  Dashboard Path:
    Text Input  → msg.payload = "Hello"
    Save Text   → flow.saved_message = msg.payload
    Send Button → msg.payload = "" (ignored)
    Load Text   → msg.payload = flow.saved_message
    Rate Limit  → pass or drop
    exec        → shell arg = msg.payload

  API Path:
    POST body   → msg.payload = { text: "Hello" }
    Extract     → msg.payload = msg.payload.text
    Rate Limit  → pass or drop
    exec        → shell arg = msg.payload

  Stop Path:
    Stop Button → msg.payload = "" (ignored)
    Set Stop    → msg.payload = "[STOP]"
    Rate Limit  → pass or drop
    exec        → shell arg = "[STOP]"
```

## Node Inventory

| Node ID | Type | Name | Tab |
|---------|------|------|-----|
| `db2_text_input` | ui-text-input | Message Input | Microbit |
| `store_variable` | change | Save Text | Microbit |
| `db2_btn_start` | ui-button | Start Button | Microbit |
| `get_variable` | change | Load Text | Microbit |
| `db2_btn_stop` | ui-button | Stop Button | Microbit |
| `set_stop_msg` | change | Set Stop Payload | Microbit |
| `rate_limit_node` | delay | Prevent BT Spam | Microbit |
| `send_script_node` | exec | Send to Micro:bit | Microbit |
| `debug_node` | debug | Script Output | Microbit |
| `http_in_node` | http in | POST /microbit | Microbit |
| `http_response_node` | http response | Reply OK | Microbit |
| `prepare_n8n_payload` | change | Extract Text | Microbit |
