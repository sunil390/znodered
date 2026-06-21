# Presence Automation — Design

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Node-RED (Raspberry Pi)                                                     │
│                                                                              │
│  ┌────────────┐     ┌───────────────────────────────────┐                    │
│  │ MQTT In    │────▶│ Track Targets (Function Node)     │                    │
│  │ home/radar/│     │                                   │                    │
│  │ +/+/state  │     │ • Parse topic → target + axis     │                    │
│  └────────────┘     │ • Presence state machine          │                    │
│                     │ • Departure: 2 min spot / 4 min   │                    │
│                     │ • Geofence with hysteresis         │                    │
│                     │ • Emit visualization (out 1)       │                    │
│                     │ • Emit Alexa on/off (out 2)        │                    │
│                     └──────────┬──────────┬─────────────┘                    │
│                        Out 1   │          │  Out 2                           │
│                                │          │                                  │
│                 ┌──────────────▼──┐   ┌───▼───────────────┐                  │
│                 │ Radar Sweep     │   │ Alexa Control     │                  │
│                 │ (ui-template)   │   │ on → plug ON      │                  │
│                 │ Canvas + Vue.js │   │ off → plug OFF    │                  │
│                 │ 120° FOV        │   │                   │                  │
│                 │ Lerp smoothing  │   │                   │                  │
│                 │ /radar page     │   │                   │                  │
│                 └─────────────────┘   └───────────────────┘                  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
         ▲                                    │
         │ MQTT                               │ HTTPS (Alexa)
         │                                    ▼
┌────────┴─────────┐                ┌──────────────────┐
│ ESP32-S3         │                │ Amazon Alexa     │
│ + RD-03D Radar   │                │ Smart Plug       │
│ (ESPHome MQTT)   │                └──────────────────┘
└──────────────────┘
```

## Design Decisions

### DD-01: Single function node for all tracking logic

**Decision**: All state management, geofence evaluation, and presence logic lives in one function node ("Track Targets").

**Rationale**: The logic is tightly coupled — presence depends on coordinates, geofence depends on distance, and the output decision depends on all of these. Splitting into multiple nodes would require complex state synchronization via context. A single function node with `flow.get("radarMap")` keeps it atomic.

**Tradeoff**: The function is ~200 lines. Acceptable for home automation — the complexity is inherent to the radar's bursty behavior.

### DD-02: Two outputs — visualization + Alexa

**Decision**: Output 1 = radarMap payload (emitted on every coordinate update). Output 2 = "on"/"off" string (only on `occupied` state transitions).

**Rationale**: The radar canvas needs frequent updates to render smooth blip movement. The Alexa command should only fire on transitions. Separating outputs avoids downstream filtering.

### DD-03: Timeout-based departure (no grace period)

**Decision**: Departure is driven solely by `target_count = 0` duration — 2 minutes for spot clearing, 4 minutes for Alexa off. No separate grace period on `target_detected`.

**Rationale**: The RD-03D's `target_detected` signal mirrors `target_count` exactly (both go OFF within 0.5s of each other). It provides no independent "stationary presence" detection. A grace period on `target_detected` OFF added no value and caused false departures during normal stillness gaps. Long timeouts on `target_count = 0` work because micro-movements (fidgeting, typing, breathing) produce count > 0 spikes every 5-90 seconds, resetting the timer.

### DD-04: Two-stage departure (2 min spots / 4 min Alexa)

**Decision**: After 2 minutes of continuous `target_count = 0`, clear display spots. After 4 minutes, turn off Alexa.

**Rationale**: The 2-minute spot clearing is fast enough to feel responsive after leaving (~2:10 total including ghost spikes) while being long enough that normal desk stillness (micro-movements every 5-90s) keeps the timer reset. The 4-minute Alexa threshold adds an extra 2 minutes of safety for the lights — if the spot clearing was a false positive (deep reading), the person has time to move before lights go off.

### DD-05: Geofence hysteresis (100mm band)

**Decision**: Enter zone at ≤2000mm, exit zone at ≥2100mm.

**Rationale**: Without hysteresis, a person standing at exactly 2m causes rapid in/out toggling as coordinates jitter ±50mm. The 100mm dead band eliminates this.

### DD-06: Auto-recover not gated on presenceOffSince

**Decision**: Auto-recovery from coordinates fires whenever valid numeric data > 5mm arrives, regardless of `presenceOffSince` state.

**Rationale**: Since `target_detected` mirrors `target_count` (both toggle together), gating coordinate tracking on `presenceOffSince === 0` blocked position updates during normal sitting-still periods when `target_detected` briefly went OFF. This caused jerky spot movement. The long departure timeouts (2-4 min) provide sufficient protection against stale coordinates re-enabling presence after true departure.

### DD-07: Client-side lerp for smooth visualization

**Decision**: Function node passes raw coordinates. All visual smoothing happens in the Vue canvas component via lerp interpolation at 60fps.

**Rationale**: 
- Server-side EMA + client-side lerp causes double-smoothing artifacts (wobbly chasing)
- The radar's bursty pattern (data → nan gap → data) means smoothing at the data layer hides position information
- Client-side lerp at `baseEase=0.06` provides a ~500ms glide between readings, masking the 0.3-2s data gaps

### DD-08: 120° arc visualization matching hardware FOV

**Decision**: Radar display shows a 120° cone (±60° from center) instead of a full 180° semicircle.

**Rationale**: The RD-03D's actual scanning field is 120°. Showing 180° would display dead space where targets can never appear, making the visualization misleading.

### DD-09: Staleness-based target expiry with ID-swap resilience

**Decision**: Individual targets expire after 10s without a coordinate update, BUT only when the radar reports fewer active targets than we're currently tracking (excess slots > 0). If all tracked slots are stale simultaneously, they are preserved.

**Rationale**: The RD-03D can swap target IDs when targets enter or leave the scene — what was t1 becomes t2 and vice versa. A naive "clear t2 when count < 2" approach kills the real person's data after a swap. The staleness + excess-slot logic handles both scenarios:
- **Stillness** (person sitting, no motion): All slots go stale, `target_count` drops to 0, but `freshSlots = 0` → `excessSlots = 0` → nothing expires. The person's last known geofence state is preserved.
- **ID swap** (person B leaves, radar reassigns IDs): The real person gets fresh coordinates under their new ID within ~1s. Old slot is stale AND `freshSlots > 0` → `excessSlots > 0` → stalest slot expires.
- Targets are evaluated stalest-first so the correct ghost gets expired during swaps.

### DD-10: Geofence-only power control

**Decision**: `occupied` (which drives Alexa on/off) is based solely on `anyActive` (target within 2m geofence), not on presence alone.

**Rationale**: The user wants power on only when someone is physically within the 2m working perimeter. Presence at >2m (e.g., walking past the room) should not trigger power-on. The geofence with hysteresis provides a clean boundary.

## State Machine

```
                         target_detected ON
                         or coords > 5mm
                    ┌────────────────────────────┐
                    │                            │
                    ▼                            │
┌─────────────┐  coords > 5mm  ┌─────────────┐ │
│  IDLE       │────────────────▶│  PRESENT    │ │
│  (all reset)│                 │  (tracking) │ │
└──────┬──────┘                 └──────┬──────┘ │
       ▲                               │        │
       │                               │target_count = 0
       │                               ▼        │
       │                        ┌─────────────┐ │
       │  count > 0 resets       │  COUNTING  │─┘
       │  timer                 │  (waiting) │
       │                        └────┬──┬─────┘
       │                             │  │
       │                     2 min   │  │ 4 min
       │                             ▼  │
       │                  ┌──────────┐  │
       │                  │SPOT_HOLD│  │
       │                  │(clear   │  │
       │                  │ spots)  │  │
       │                  └──────────┘  │
       │                             ▼
       │                  ┌──────────┐
       └──────────────────│ALEXA_OFF│
                          │(presence│
                          │ false)  │
                          └──────────┘
```

## MQTT Topic Structure

```
home/radar/
├── sensor/
│   ├── target_count/state          → integer (0-3, number of moving targets)
│   ├── target_1_x/state            → float (mm, lateral displacement)
│   ├── target_1_y/state            → float (mm, depth from radar)
│   ├── target_1_speed/state        → float (speed, not used by function)
│   ├── target_2_x/state            → float (mm)
│   ├── target_2_y/state            → float (mm)
│   ├── target_2_speed/state        → float
│   ├── target_3_x/state            → float (mm)
│   ├── target_3_y/state            → float (mm)
│   └── target_3_speed/state        → float
└── binary_sensor/
    ├── target_detected/state       → "on" | "off" (mirrors target_count > 0)
    ├── target_1_presence/state     → "on" | "off" (per-target, not used)
    ├── target_2_presence/state     → "on" | "off"
    └── target_3_presence/state     → "on" | "off"
```

> MQTT subscription uses `home/radar/+/+/state` to match both `sensor/` and `binary_sensor/` paths in a single subscription.

## Processing Pipeline

```
Step 1: Auto-Recover — set presence=true from valid coords > 5mm
Step 2: target_detected handling — ON=set presence true, OFF=record timestamp
Step 3a: target_count — count>0 resets departure timer; count=0 starts timer
         Also stores lastTargetCount for excess-slot detection
Step 3b: Departure actions — 2 min: clear spots; 4 min: Alexa off
Step 3c: Coordinate tracking — store raw x/y per target (if presence=true)
Step 4: Geofence evaluation — staleness check (10s) with excess-slot guard,
         then distance calc + enter/exit hysteresis. Stalest evaluated first.
Step 5: Output routing — emit radarMap if updated; emit "on"/"off" if occupied changed
         occupied = anyActive (geofence only, not presence alone)
```

## Dashboard Layout

```
zDash (/dashboard)
├── Page: Micro:bit (/dashboard)   ← Flow 1
│   └── Group: Micro:bit Messaging Control (6-col)
│
└── Page: Radar (/radar)           ← This flow
    └── Group: RD-03D Radar (6×9)
        └── Live Radar Sweep (canvas, full group, 120° FOV)

Theme: "znext"
  surface: #d4651c (orange)
  primary: #0094ce (blue)
  bgPage:  #eeeeee (light gray)
```
