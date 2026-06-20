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
│  │ state      │     │ • Presence state machine          │                    │
│  └────────────┘     │ • Grace period (60s OFF delay)    │                    │
│                     │ • Target count force-off (5 min)   │                    │
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

### DD-03: 60-second grace period instead of instant OFF

**Decision**: When `target_detected` goes OFF, wait 60 seconds before trusting it.

**Rationale**: The RD-03D's FMCW detection drops out frequently during stationary periods (no Doppler return). A 60s grace period prevents false departures. If `target_detected` returns ON during the grace window, it's cancelled immediately.

### DD-04: Target count force-off (5 minutes)

**Decision**: After 5 continuous minutes of `target_count = 0`, force presence off regardless of `target_detected`.

**Rationale**: Handles the case where `target_detected` gets stuck ON (sensor bug or firmware issue). 5 minutes is long enough that any real person would produce at least one micro-movement resetting the timer. After force-off, `presenceOffSince` stays non-zero to block stale coordinates from re-enabling presence — only `target_count > 0` can unblock.

### DD-05: Geofence hysteresis (100mm band)

**Decision**: Enter zone at ≤2000mm, exit zone at ≥2100mm.

**Rationale**: Without hysteresis, a person standing at exactly 2m causes rapid in/out toggling as coordinates jitter ±50mm. The 100mm dead band eliminates this.

### DD-06: Auto-recover gated on presenceOffSince

**Decision**: Auto-recovery from coordinates only fires when `presenceOffSince === 0`.

**Rationale**: If `target_detected` has said OFF (or force-off has fired), stale coordinates still arriving should NOT override that decision. Only `target_count > 0` (proof of real movement) can unblock.

### DD-07: Client-side lerp for smooth visualization

**Decision**: Function node passes raw coordinates. All visual smoothing happens in the Vue canvas component via lerp interpolation at 60fps.

**Rationale**: 
- Server-side EMA + client-side lerp causes double-smoothing artifacts (wobbly chasing)
- The radar's bursty pattern (data → nan gap → data) means smoothing at the data layer hides position information
- Client-side lerp at `baseEase=0.06` provides a ~500ms glide between readings, masking the 0.3-2s data gaps

### DD-08: 120° arc visualization matching hardware FOV

**Decision**: Radar display shows a 120° cone (±60° from center) instead of a full 180° semicircle.

**Rationale**: The RD-03D's actual scanning field is 120°. Showing 180° would display dead space where targets can never appear, making the visualization misleading.

## State Machine

```
                         target_detected ON
                         or target_count > 0
                    ┌────────────────────────────┐
                    │                            │
                    ▼                            │
┌─────────────┐  coords > 5mm  ┌─────────────┐ │
│  IDLE       │────────────────▶│  PRESENT    │ │
│  (all reset)│  (if unblocked) │  (tracking) │ │
└──────┬──────┘                 └──────┬──────┘ │
       ▲                               │        │
       │                               │target_detected OFF
       │                               ▼        │
       │                        ┌─────────────┐ │
       │  grace period          │  GRACE      │ │
       │  expires (60s)         │  (60s wait) │─┘
       │                        └──────┬──────┘
       │                               │
       │                               │ 60s elapsed
       │                               ▼
       │                        ┌─────────────┐
       ├────────────────────────│  DEPARTED   │
       │                        │  (wipe all) │
       │                        └─────────────┘
       │
       │  target_count=0 for 5 min
       │                        ┌─────────────┐
       └────────────────────────│  FORCE OFF  │
                                │  (blocked)  │
                                └─────────────┘
```

## MQTT Topic Structure

```
home/radar/sensor/
├── target_detected/state       → "on" | "off" (composite presence binary)
├── target_count/state          → integer (0-3, number of moving targets)
├── target_1_x/state            → float (mm, lateral displacement)
├── target_1_y/state            → float (mm, depth from radar)
├── target_1_presence/state     → "on" | "off" (per-target, not used by function)
├── target_2_x/state            → float (mm)
├── target_2_y/state            → float (mm)
├── target_2_presence/state     → "on" | "off"
├── target_3_x/state            → float (mm)
├── target_3_y/state            → float (mm)
└── target_3_presence/state     → "on" | "off"
```

## Processing Pipeline

```
Step 1: Auto-Recover — set presence=true from valid coords (gated on presenceOffSince===0)
Step 2: target_detected handling — ON=immediate trust, OFF=start grace timer
Step 3a: target_count — count>0 unblocks all; count=0 starts spot-hold + force-off timers
Step 3b: Coordinate tracking — store raw x/y per target (only if presence=true + unblocked)
Step 4: Geofence evaluation — calculate distance, apply enter/exit hysteresis
Step 5: Output routing — emit radarMap if updated; emit "on"/"off" if occupied changed
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
