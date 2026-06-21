let radarMap = flow.get("radarMap") || {
    t1: { x: 0, y: 0, active: false, distance: 0, lastUpdate: 0, inZone: false, lastAxis: null },
    t2: { x: 0, y: 0, active: false, distance: 0, lastUpdate: 0, inZone: false, lastAxis: null },
    t3: { x: 0, y: 0, active: false, distance: 0, lastUpdate: 0, inZone: false, lastAxis: null },
    presence: false,
    lastPresenceUpdate: 0,
    presenceOffSince: 0,       // timestamp when OFF was first received (grace period)
    targetCountZeroSince: 0,   // timestamp when target_count first hit 0
    lastTargetCount: 0,        // last reported target_count from radar
    anyActive: false,
    occupied: false    // primary output: geofenced target within 2m
};

let topic = msg.topic;
let payloadStr = String(msg.payload).toLowerCase().trim();

// All distances in mm (radar reports mm natively)
const GEOFENCE_ENTER = 2000;   // Enter zone at ≤2000mm (2m)
const GEOFENCE_EXIT  = 2100;   // Exit zone at ≥2100mm (hysteresis band = 100mm)
const MIN_COORDINATE = 5;      // Ignore coordinates < 5mm (noise floor)
const TARGET_STALE = 10000;    // 10s without coord update → target gone (RD-03D updates ~1s)
const STICKY_TIMEOUT = 1800000; // 30 min hold before expiring presence-kept target
const SPOT_HOLD = 120000;      // 2 min of target_count=0 → clear spots from display
const ALEXA_OFF = 240000;      // 4 min of target_count=0 → Alexa off

let now = Date.now();
let updated = false;
let isNumeric = (payloadStr !== "nan" && payloadStr !== "unknown" && payloadStr !== "" && !isNaN(Number(payloadStr)));

// 1. Auto-Recover Presence (only for fresh, meaningful coordinates)
if (isNumeric && topic.includes("target_")) {
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
        // OFF received — record timestamp (step 3b handles actual clearing)
        if (radarMap.presenceOffSince === 0) {
            radarMap.presenceOffSince = now;
        }
    }
}

// 3a. Target Count — primary departure detection
if (topic.endsWith("target_count/state")) {
    let count = parseInt(msg.payload);
    if (!isNaN(count)) radarMap.lastTargetCount = count;
    if (count > 0 && !isNaN(count)) {
        // Real target — reset departure timer
        radarMap.targetCountZeroSince = 0;
    } else {
        // target_count = 0 — start departure timer
        if (radarMap.targetCountZeroSince === 0) {
            radarMap.targetCountZeroSince = now;
        }
    }
}

// 3b. Departure actions — based on target_count=0 duration
// Doppler radar can't see stationary targets, so count=0 during stillness gaps.
// Use long timeouts so micro-movements (every 30-90s) reset the timer.
if (radarMap.targetCountZeroSince > 0) {
    let zeroElapsed = now - radarMap.targetCountZeroSince;
    
    // 2 min of no targets: clear spots from display
    if (zeroElapsed >= SPOT_HOLD) {
        ['t1', 't2', 't3'].forEach(k => {
            radarMap[k].x = 0; radarMap[k].y = 0; radarMap[k].active = false;
            radarMap[k].inZone = false; radarMap[k].distance = 0;
            radarMap[k].lastUpdate = 0; radarMap[k].lastAxis = null;
        });
        updated = true;
    }
    
    // 5 min of no targets: presence off → Alexa off
    if (zeroElapsed >= ALEXA_OFF) {
        radarMap.presence = false;
        radarMap.lastPresenceUpdate = now;
        radarMap.presenceOffSince = now; // block auto-recover until real return
        ['t1', 't2', 't3'].forEach(k => {
            radarMap[k].x = 0; radarMap[k].y = 0; radarMap[k].active = false;
            radarMap[k].inZone = false; radarMap[k].distance = 0;
            radarMap[k].lastUpdate = 0; radarMap[k].lastAxis = null;
        });
        updated = true;
    }
}

// 3c. Coordinate Tracking
if (isNumeric && radarMap.presence) {
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
// RD-03D is Doppler — stationary targets stop getting coordinate updates AND
// target_count drops to 0 during stillness. Only use target_count for excess
// detection when at least one slot is actively receiving fresh coords (proving
// someone is moving). If all slots are stale, everyone is still — keep them.
if (radarMap.presence) {
    let slots = [radarMap.t1, radarMap.t2, radarMap.t3];
    let trackedSlots = slots.filter(t => t.lastUpdate > 0).length;
    let freshSlots = slots.filter(t => t.lastUpdate > 0 && (now - t.lastUpdate) <= TARGET_STALE).length;

    // Only trust target_count for expiry when fresh movement proves it's reliable
    let excessSlots = (freshSlots > 0)
        ? trackedSlots - Math.max(radarMap.lastTargetCount, freshSlots)
        : 0; // all stale = everyone still, don't expire

    const evaluateTarget = (t) => {
        if (t.lastUpdate === 0) return; // never updated
        let staleMs = now - t.lastUpdate;
        if (staleMs > TARGET_STALE && excessSlots > 0) {
            // Stale AND confirmed excess (another slot has fresh coords) → expired/swapped
            t.x = 0; t.y = 0; t.active = false; t.inZone = false;
            t.distance = 0; t.lastUpdate = 0; t.lastAxis = null;
            excessSlots--;
            updated = true;
        } else {
            t.distance = Math.sqrt(t.x * t.x + t.y * t.y);
            t.active = (t.distance > 0);
            // Hysteresis: use different thresholds for entering vs leaving zone
            if (t.inZone) {
                t.inZone = (t.distance <= GEOFENCE_EXIT);
            } else {
                t.inZone = (t.distance > 0 && t.distance <= GEOFENCE_ENTER);
            }
        }
    };
    // Evaluate stalest first so the right one gets expired
    let targets = [
        { key: 't1', t: radarMap.t1 },
        { key: 't2', t: radarMap.t2 },
        { key: 't3', t: radarMap.t3 }
    ].sort((a, b) => a.t.lastUpdate - b.t.lastUpdate);
    targets.forEach(({ t }) => evaluateTarget(t));
}

// 5. Check Global Trigger & Route Outputs
// occupied = geofenced target only (must be within 2m to power on)
let lastAnyActive = radarMap.anyActive;
let lastOccupied = radarMap.occupied;
radarMap.anyActive = (radarMap.t1.inZone || radarMap.t2.inZone || radarMap.t3.inZone);
radarMap.occupied = radarMap.anyActive;
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
