# Presence Automation — Design

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Node-RED (Raspberry Pi)                                                     │
│                                                                              │
│  ┌────────────┐     ┌───────────────────────────────────┐                    │
│  │ MQTT In    │────▶│ Track Targets (Function Node)     │                    │
│  │ home/radar/│     │                                   │                    │
│  │ sensor/+/  │     │ • Parse topic → target + axis     │                    │
│  │ state      │     │ • Update flow.radarMap            │                    │
│  └────────────┘     │ • Calculate distance              │                    │
│                     │ • Evaluate geofence               │                    │
│                     │ • Determine presence state         │                    │
│                     │ • Emit visualization data (out 1)  │                    │
│                     │ • Emit commands (out 2)            │                    │
│                     └──────────┬──────────┬─────────────┘                    │
│                        Out 1   │          │  Out 2                           │
│                                │          │                                  │
│                 ┌──────────────▼──┐   ┌───▼───────────────┐                  │
│                 │ Radar Sweep     │   │ Route Commands    │                  │
│                 │ (ui-template)   │   │ (switch node)     │                  │
│                 │ Canvas + Vue.js │   │ "on" → output 1   │                  │
│                 │ /radar page     │   │ "off" → output 2  │                  │
│                 └─────────────────┘   └───┬──────────┬────┘                  │
│                                           │          │                       │
│                                    "on"   │          │  "off"                │
│                                           │          │                       │
│                        ┌──────────────────▼┐    ┌────▼─────────────────┐     │
│                        │ Alexa: Plug ON    │    │ Trigger: Wait 10s   │     │
│                        │ (routine call)    │    │ (departure debounce) │     │
│                        └──────────────────┬┘    └────┬─────────────────┘     │
│                                           │          │                       │
│                        ┌──────────────────▼┐         │                       │
│                        │ Cancel OFF Timer  │         ▼                       │
│                        │ msg.reset = true  │    ┌──────────────────┐         │
│                        │ ─────────────────▶│───▶│ Alexa: Plug OFF │         │
│                        └───────────────────┘    │ (routine call)   │         │
│                                                 └────────┬─────────┘         │
│                                                          │                   │
│  ┌ ─ ─ ─ ─ ─ ─ NOTIFICATIONS (chained after Alexa) ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ┐  │
│                                                          │                  │
│  │  Plug ON ──▶ ┌──────────┐ ──▶ ┌──────────────────┐    │               │  │
│                 │ "Arrived"│     │ ntfy: Arrival    │    │                  │
│  │              │ (change) │     │ POST zpi-Presence│    │               │  │
│                 └──────────┘     └──────────────────┘    │                  │
│  │                                                       │               │  │
│               Plug OFF ──▶ ┌──────────┐ ──▶ ┌───────────▼──────────┐     │  │
│  │                         │ "Left"   │     │ ntfy: Departure      │        │
│                            │ (change) │     │ POST zpi-Presence    │     │  │
│  │                         └──────────┘     └──────────────────────┘        │
│  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
         ▲                                    │                  │
         │ MQTT                               │ HTTPS (Alexa)    │ HTTPS (ntfy)
         │                                    ▼                  ▼
┌────────┴─────────┐                ┌──────────────────┐  ┌─────────────┐
│ RD-03D Radar     │                │ Amazon Alexa     │  │ ntfy.sh     │
│ (mmWave sensor)  │                │ Smart Plug       │  │ Mobile Push │
│ via ESPHome      │                └──────────────────┘  └─────────────┘
└──────────────────┘
```

## Design Decisions

### DD-01: Single function node for all tracking logic

**Decision**: All state management, geofence evaluation, and presence logic lives in one function node ("Track Targets").

**Rationale**: The logic is tightly coupled — presence depends on coordinates, geofence depends on distance, and the output decision depends on all of these. Splitting into multiple nodes would require complex state synchronization via context. A single function node with `flow.get("radarMap")` keeps it atomic.

**Tradeoff**: The function is ~100 lines and harder to unit test. Acceptable for a home automation use case.

### DD-02: Two outputs from the function node

**Decision**: Output 1 = visualization data (always emitted on updates). Output 2 = command signals ("on"/"off", only emitted on state transitions).

**Rationale**: Separates concerns downstream. The radar canvas needs every coordinate update to render smoothly. The Alexa commands should only fire on transitions (entering/leaving zone), not on every data point.

### DD-03: 10-second departure debounce with cancellation

**Decision**: Use a `trigger` node with 10s delay before sending "off". The "on" path also sends `msg.reset = true` to cancel any pending off timer.

**Rationale**: mmWave radar can briefly lose tracking (target turns, occlusion). A hard 10s debounce prevents light flickering. The cancellation ensures that if the person returns within 10s, the plug stays on seamlessly.

### DD-04: 30-minute sticky timeout

**Decision**: Once a target is marked `inZone`, it stays active for 30 minutes even without new coordinate updates.

**Rationale**: When a person sits perfectly still (reading, sleeping), the radar may stop reporting coordinate updates. The sticky timeout prevents false "departure" triggers during stationary periods. 30 minutes is conservative — most movement-free periods are shorter.

### DD-05: Instant wipe on explicit presence=false

**Decision**: When the radar's presence binary sensor explicitly reports `off/false`, all target state is immediately zeroed out.

**Rationale**: The RD-03D's built-in presence algorithm is authoritative. If it says "no one is here," trust it over the sticky timeout. This handles edge cases where the radar legitimately confirms the room is empty.

### DD-06: Auto-recover presence from coordinate data

**Decision**: If any valid coordinate data arrives while `presence=false`, automatically set `presence=true`.

**Rationale**: Race condition protection. The radar sometimes sends target coordinates before (or without) an explicit presence state change. If we're getting coordinates, someone is obviously there.

### DD-07: Client-side rendering for radar visualization

**Decision**: The radar sweep is rendered entirely client-side using a Vue.js `<canvas>` component in a `ui-template` node.

**Rationale**: 
- Server-side rendering at 60fps would overload the Pi's CPU
- The sweep animation is purely cosmetic (rotating line) — no server data needed for it
- Target positions are interpolated client-side for smooth movement between server updates
- Canvas is self-contained — no external dependencies

### DD-08: Chained notifications after Alexa routines

**Decision**: The ntfy notification nodes are wired in series after the Alexa routine nodes (Plug ON → Arrived → ntfy, Plug OFF → Left → ntfy), not in parallel from the Route Commands switch.

**Rationale**: Ensures the notification only fires if the Alexa routine call completes. If Alexa fails, you still get notified (the http request node runs regardless of upstream errors), but the causal chain is clear: plug action → notification. This also avoids adding more outputs to the switch node.

### DD-09: Both notifications use Priority High

**Decision**: Both arrival and departure ntfy notifications use `Priority: High`.

**Rationale**: Presence events are infrequent (a few per day) and actionable. High priority ensures they cut through phone Do Not Disturb / silent modes on both Android and iOS.

## State Machine

```
                    ┌─────────────────────────────┐
                    │                             │
                    ▼                             │
┌─────────────┐  coordinates   ┌──────────────┐  │
│  NO_PRESENCE │──────────────▶│  TRACKING    │  │
│  (all reset) │               │  (updating)  │  │
└──────┬───────┘               └──────┬───────┘  │
       ▲                              │          │
       │                              │ distance │
       │  presence=false              │ < 2000mm │
       │  (instant wipe)              ▼          │
       │                       ┌──────────────┐  │
       ├───────────────────────│  IN_ZONE     │  │
       │                       │  (cmd = "on")│  │
       │                       └──────┬───────┘  │
       │                              │          │
       │                              │ distance │
       │                              │ > 2000mm │
       │                              │ + 30min  │
       │                              │ timeout  │
       │                              ▼          │
       │                       ┌──────────────┐  │
       └───────────────────────│  DEPARTING   │──┘
                               │  (cmd = "off")│
                               │  10s debounce │
                               └──────────────┘
```

## MQTT Topic Structure

```
home/radar/sensor/
├── presence/state           → "on" | "off"
├── target_detected/state    → "on" | "off"
├── target_1/
│   ├── x/state             → float (mm)
│   └── y/state             → float (mm)
├── target_2/
│   ├── x/state             → float (mm)
│   └── y/state             → float (mm)
└── target_3/
    ├── x/state             → float (mm)
    └── y/state             → float (mm)
```

## Node Inventory

| Node ID | Type | Name | Purpose |
|---------|------|------|---------|
| `355d91b376838afd` | mqtt in | Radar Ingest | Subscribe to all radar topics |
| `f6fa7c91edf99328` | function | Track Targets (Auto-Recover) | Core state machine |
| `4548557c61c0631b` | ui-template | Live Radar Sweep | Canvas visualization |
| `route_alexa_commands` | switch | Route Commands | Split on/off paths |
| `0a7170b8fa33ca8a` | alexa-remote-routine | Plug On (Arrival) | Trigger Alexa ON routine |
| `1b8af07c0798800c` | alexa-remote-routine | Plug Off (Departure) | Trigger Alexa OFF routine |
| `cancel_off_timer` | change | Cancel OFF Timer | Set msg.reset for trigger |
| `3ff8616701896538` | trigger | Wait 10s for Departure | Debounce before OFF |
| `4619beb21109b99a` | change | Arrived | Set payload for arrival notification |
| `61d0568a16f037c4` | http request | Notify Arrival | POST to ntfy.sh on arrival |
| `0e365b1bf5f245dd` | change | Left | Set payload for departure notification |
| `7ae4ed7c51d7819a` | http request | Notify Departure | POST to ntfy.sh on departure |

## Dashboard Layout

```
zDash (/dashboard)
├── Page: Micro:bit (/dashboard)   ← Flow 1
│   └── Group: Micro:bit Messaging Control (6-col)
│
└── Page: Radar (/radar)           ← This flow
    └── Group: RD-03D Radar (6×9)
        └── Live Radar Sweep (canvas, full group)

Theme: "znext"
  surface: #d4651c (orange)
  primary: #0094ce (blue)
  bgPage:  #eeeeee (light gray)
```
