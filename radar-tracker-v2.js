let radarMap = flow.get("radarMap") || {
    t1: { x: 0, y: 0, active: false, distance: 0, lastUpdate: 0, inZone: false, lastAxis: null },
    t2: { x: 0, y: 0, active: false, distance: 0, lastUpdate: 0, inZone: false, lastAxis: null },
    t3: { x: 0, y: 0, active: false, distance: 0, lastUpdate: 0, inZone: false, lastAxis: null },
    presence: false,
    lastPresenceUpdate: 0,
    presenceOffSince: 0,       // timestamp when OFF was first received (grace period)
    targetCountZeroSince: 0,   // timestamp when target_count first hit 0
    anyActive: false,
    occupied: false    // primary output: presence OR active geofence target
};

let topic = msg.topic;
let payloadStr = String(msg.payload).toLowerCase().trim();

// All distances in mm (radar reports mm natively)
const GEOFENCE_ENTER = 2000;   // Enter zone at ≤2000mm (2m)
const GEOFENCE_EXIT  = 2100;   // Exit zone at ≥2100mm (hysteresis band = 100mm)
const MIN_COORDINATE = 5;      // Ignore coordinates < 5mm (noise floor)
const STICKY_TIMEOUT = 1800000; // 30 min hold before expiring a stale target
const PRESENCE_GRACE = 60000;  // 60s grace period before trusting "OFF" (prevents flicker)
const SPOT_HOLD = 10000;       // 10s hold before clearing spots after target_count drops to 0
const PRESENCE_FORCE_OFF = 300000; // 5 min of 0 targets → force presence off (overrides stuck target_detected)

let now = Date.now();
let updated = false;
let isNumeric = (payloadStr !== "nan" && payloadStr !== "unknown" && payloadStr !== "" && !isNaN(Number(payloadStr)));

// 1. Auto-Recover Presence (only for fresh, meaningful coordinates)
// Skip if grace period is active — target_detected said OFF, don't override with stale coords
if (isNumeric && topic.includes("target_") && radarMap.presenceOffSince === 0) {
    let val = Math.abs(parseFloat(msg.payload));
    if (val > MIN_COORDINATE) {
        radarMap.presence = true;
        radarMap.lastPresenceUpdate = now;
    }
}

// 2. Explicit Presence Handling with Grace Period
// Match only the overall "target_detected" sensor, NOT per-target presence (target_1_presence, etc.)
if (topic.endsWith("target_detected/state")) {
    let isPresent = (payloadStr === "on" || payloadStr === "true");
    
    if (isPresent) {
        // Immediately trust ON — cancel any pending grace period
        radarMap.presence = true;
        radarMap.lastPresenceUpdate = now;
        radarMap.presenceOffSince = 0;
    } else {
        // OFF received — start grace period (don't act immediately)
        if (radarMap.presenceOffSince === 0) {
            // First OFF: record when it started
            radarMap.presenceOffSince = now;
        } else if (now - radarMap.presenceOffSince >= PRESENCE_GRACE) {
            // OFF persisted for full grace period: truly gone
            radarMap.presence = false;
            radarMap.lastPresenceUpdate = now;
            radarMap.presenceOffSince = 0;
            ['t1', 't2', 't3'].forEach(t => {
                radarMap[t].x = 0; radarMap[t].y = 0; radarMap[t].active = false; 
                radarMap[t].inZone = false; radarMap[t].distance = 0;
                radarMap[t].lastUpdate = 0; radarMap[t].lastAxis = null;
            });
            updated = true;
        }
        // else: still within grace period, do nothing yet
    }
}

// 3a. Target Count — manage spot clearing and presence force-off
if (topic.endsWith("target_count/state")) {
    let count = parseInt(msg.payload);
    if (count > 0 && !isNaN(count)) {
        // Targets active — someone is here, cancel all pending timers and unblock
        radarMap.targetCountZeroSince = 0;
        radarMap.presenceOffSince = 0;
    } else {
        // target_count is 0 — start or check hold timer
        if (radarMap.targetCountZeroSince === 0) {
            radarMap.targetCountZeroSince = now;
        } else {
            let zeroElapsed = now - radarMap.targetCountZeroSince;
            
            // Clear spots when: target_detected is OFF + 10s of 0 count
            // (sitting still keeps spots because target_detected stays ON)
            if (zeroElapsed >= SPOT_HOLD && radarMap.presenceOffSince > 0) {
                ['t1', 't2', 't3'].forEach(k => {
                    if (radarMap[k].active) {
                        radarMap[k].x = 0; radarMap[k].y = 0; radarMap[k].active = false;
                        radarMap[k].inZone = false; radarMap[k].distance = 0;
                        radarMap[k].lastUpdate = 0; radarMap[k].lastAxis = null;
                        updated = true;
                    }
                });
            }
            
            // Force everything off after 2 min of 0 targets (overrides stuck target_detected)
            if (zeroElapsed >= PRESENCE_FORCE_OFF) {
                ['t1', 't2', 't3'].forEach(k => {
                    radarMap[k].x = 0; radarMap[k].y = 0; radarMap[k].active = false;
                    radarMap[k].inZone = false; radarMap[k].distance = 0;
                    radarMap[k].lastUpdate = 0; radarMap[k].lastAxis = null;
                });
                radarMap.presence = false;
                radarMap.lastPresenceUpdate = now;
                // Keep presenceOffSince non-zero to block step 1 from re-enabling with stale data
                radarMap.presenceOffSince = now;
                updated = true;
            }
        }
    }
}

// 3b. Coordinate Tracking (only when presence confirmed, not during grace period)
if (isNumeric && radarMap.presence && radarMap.presenceOffSince === 0) {
    let val = parseFloat(msg.payload);
    if (Math.abs(val) > MIN_COORDINATE) {
        const assignCoord = (t, axis) => {
            if (axis === "x") { t.x = val; }
            else { t.y = val; }
            t.lastUpdate = now;
            t.lastAxis = axis;
            updated = true;
        };

        if (topic.includes("target_1")) {
            if (topic.endsWith("x/state")) { assignCoord(radarMap.t1, "x"); }
            if (topic.endsWith("y/state")) { assignCoord(radarMap.t1, "y"); }
        }
        else if (topic.includes("target_2")) {
            if (topic.endsWith("x/state")) { assignCoord(radarMap.t2, "x"); }
            if (topic.endsWith("y/state")) { assignCoord(radarMap.t2, "y"); }
        }
        else if (topic.includes("target_3")) {
            if (topic.endsWith("x/state")) { assignCoord(radarMap.t3, "x"); }
            if (topic.endsWith("y/state")) { assignCoord(radarMap.t3, "y"); }
        }
    }
}

// 4. Evaluate Target Timers & Geofence with Hysteresis
if (radarMap.presence) {
    const evaluateTarget = (t) => {
        if (t.lastUpdate > 0 && (now - t.lastUpdate > STICKY_TIMEOUT)) {
            // Stale target — but only expire if presence is also stale
            // If radar still confirms presence, keep the target as "last known position"
            if (now - radarMap.lastPresenceUpdate > STICKY_TIMEOUT) {
                t.x = 0; t.y = 0; t.active = false; t.inZone = false;
                t.distance = 0; t.lastUpdate = 0; t.lastAxis = null;
                updated = true;
            } else {
                // Presence still fresh — person is likely stationary
                // Keep target alive, just recalculate
                t.distance = Math.sqrt(t.x * t.x + t.y * t.y);
                t.active = (t.distance > 0);
                if (t.inZone) {
                    t.inZone = (t.distance <= GEOFENCE_EXIT);
                } else {
                    t.inZone = (t.distance > 0 && t.distance <= GEOFENCE_ENTER);
                }
            }
        } else if (t.lastUpdate > 0) {
            t.distance = Math.sqrt(t.x * t.x + t.y * t.y);
            t.active = (t.distance > 0);
            // Hysteresis: use different thresholds for entering vs leaving zone
            if (t.inZone) {
                // Already in zone — only leave if exceeding exit threshold
                t.inZone = (t.distance <= GEOFENCE_EXIT);
            } else {
                // Outside zone — only enter if within enter threshold
                t.inZone = (t.distance > 0 && t.distance <= GEOFENCE_ENTER);
            }
        }
    };
    evaluateTarget(radarMap.t1);
    evaluateTarget(radarMap.t2);
    evaluateTarget(radarMap.t3);
}

// 5. Check Global Trigger & Route Outputs
// occupied = presence OR any geofenced target (presence is authoritative)
let lastAnyActive = radarMap.anyActive;
let lastOccupied = radarMap.occupied;
radarMap.anyActive = (radarMap.t1.inZone || radarMap.t2.inZone || radarMap.t3.inZone);
radarMap.occupied = radarMap.presence || radarMap.anyActive;
flow.set("radarMap", radarMap);

let msgUI = null;
let msgAlexa = null;

if (updated) {
    msgUI = { payload: radarMap };
}

// Alexa driven by occupied (presence-aware), not just geofence targets
if (radarMap.occupied !== lastOccupied) {
    msgAlexa = { payload: radarMap.occupied ? "on" : "off" };
}

return [msgUI, msgAlexa];
