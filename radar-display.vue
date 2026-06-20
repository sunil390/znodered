<template>
    <div style="display: flex; flex-direction: column; align-items: center; background: #000500; padding: 15px; border-radius: 8px; width: 100%; height: 100%; box-sizing: border-box; overflow: hidden; border: 2px solid #003300;">
        <h3 style="color: #33ff33; font-family: 'Courier New', Courier, monospace; margin-top: 0; margin-bottom: 8px; font-size: 16px; font-weight: bold; letter-spacing: 2px; text-shadow: 0 0 8px #00ff00;">TACTICAL RADAR LINK</h3>
        <div style="flex: 1; display: flex; align-items: flex-end; justify-content: center; width: 100%; height: 100%; overflow: hidden;">
            <canvas ref="radarCanvas" width="800" height="400" style="background: #000a00; border-radius: 4px; width: 100%; max-height: 100%; object-fit: contain; aspect-ratio: 2/1; box-shadow: inset 0 0 60px rgba(0, 50, 0, 0.8);"></canvas>
        </div>
    </div>
</template>

<script>
export default {
    name: 'RadarSweepCanvas',
    props: ['id', 'props', 'state'],
    data() {
        return {
            sweepAngle: -Math.PI,
            targetDest: {
                t1: {x:0, y:0, active: false},
                t2: {x:0, y:0, active: false},
                t3: {x:0, y:0, active: false}
            },
            targetDisplay: {
                t1: {x:0, y:0, active: false, initialized: false},
                t2: {x:0, y:0, active: false, initialized: false},
                t3: {x:0, y:0, active: false, initialized: false}
            },
            maxRange: 3.5,  // Match actual room depth in meters (was 6.0)
            animationFrameId: null,
            lastTime: 0
        }
    },
    mounted() {
        const canvas = this.$refs.radarCanvas;
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        const padding = 20; 
        const cx = canvas.width / 2;
        const cy = canvas.height - 10; 
        
        // Dynamic scale ensures the radius fits perfectly within canvas bounds
        const maxRadius = Math.min(canvas.width / 2 - padding, canvas.height - padding);
        const scale = maxRadius / this.maxRange;

        // Ensure socket listener exists before binding (mocked/safeguarded for portability)
        if (this.$socket) {
            this.$socket.on('msg-input:' + this.id, (msg) => {
                if (msg && msg.payload && typeof msg.payload === 'object') {
                    ['t1', 't2', 't3'].forEach(t => {
                        if (msg.payload[t]) {
                            this.targetDest[t].x = (msg.payload[t].x || 0) / 1000;
                            this.targetDest[t].y = (msg.payload[t].y || 0) / 1000;
                            this.targetDest[t].active = msg.payload[t].active || false;
                            
                            if (!this.targetDisplay[t].initialized && this.targetDest[t].active) {
                                this.targetDisplay[t].x = this.targetDest[t].x;
                                this.targetDisplay[t].y = this.targetDest[t].y;
                                this.targetDisplay[t].initialized = true;
                            }
                            this.targetDisplay[t].active = this.targetDest[t].active;
                        }
                    });
                }
            });
        }

        const lerp = (start, end, amt) => (1 - amt) * start + amt * end;
        this.lastTime = performance.now();

        const drawRadar = (timestamp) => {
            let dt = (timestamp - this.lastTime) / 16.666; 
            if (isNaN(dt) || dt > 10) dt = 1;
            this.lastTime = timestamp;

            // 1. The Phosphor Fade Effect
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = 'rgba(0, 10, 0, 0.08)'; 
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Reset Shadows for grid
            ctx.shadowBlur = 0;

            // RD-03D scanning area: 120° arc centered at straight ahead (±60°)
            const ARC_START = 7 * Math.PI / 6;   // 210° — left edge
            const ARC_END   = 11 * Math.PI / 6;  // 330° — right edge

            // 2. Grid Rings (Every 1m) — 120° arc only
            ctx.strokeStyle = 'rgba(0, 255, 0, 0.08)';
            ctx.lineWidth = 1;
            ctx.font = '10px Courier New';
            ctx.textBaseline = 'bottom';
            ctx.textAlign = 'center';

            for (let r = 1; r <= this.maxRange; r += 1) {
                ctx.beginPath();
                ctx.arc(cx, cy, r * scale, ARC_START, ARC_END);
                ctx.stroke();
                
                ctx.fillStyle = 'rgba(0, 255, 0, 0.5)';
                ctx.fillText(r + 'm', cx + 2, cy - (r * scale) + 12);
            }

            // 3. Cross Rays (30° increments within 120° FOV)
            const angles = [Math.PI * 7/6, Math.PI * 4/3, Math.PI * 3/2, Math.PI * 5/3, Math.PI * 11/6];
            angles.forEach(a => {
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(cx + Math.cos(a) * (this.maxRange * scale), cy + Math.sin(a) * (this.maxRange * scale));
                ctx.stroke();
            });

            // 3b. Outer boundary arc + edge lines
            ctx.strokeStyle = 'rgba(0, 255, 0, 0.2)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(cx, cy, this.maxRange * scale, ARC_START, ARC_END);
            ctx.stroke();

            // 4. The Sweeper Arm (sweeps within 120° arc)
            this.sweepAngle += 0.015 * dt;
            if (this.sweepAngle > -Math.PI / 6) this.sweepAngle = -5 * Math.PI / 6;
            
            ctx.shadowBlur = 15;
            ctx.shadowColor = '#00ff00';
            ctx.strokeStyle = '#33ff33';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(this.sweepAngle) * (this.maxRange * scale), cy + Math.sin(this.sweepAngle) * (this.maxRange * scale));
            ctx.stroke();

            // Smooth Target Movement — slow glide masks radar's bursty data gaps
            const baseEase = 0.06;  // Glide over ~500ms (radar bursts have 0.3-2s gaps)
            const currentEase = Math.min(1, baseEase * dt);

            ['t1', 't2', 't3'].forEach(t => {
                if (this.targetDisplay[t].active) {
                    this.targetDisplay[t].x = lerp(this.targetDisplay[t].x, this.targetDest[t].x, currentEase);
                    this.targetDisplay[t].y = lerp(this.targetDisplay[t].y, this.targetDest[t].y, currentEase);
                } else {
                    this.targetDisplay[t].initialized = false;
                }
            });

            // Draw Targets
            this.drawBlip(ctx, cx, cy, scale, this.targetDisplay.t1, 'T1');
            this.drawBlip(ctx, cx, cy, scale, this.targetDisplay.t2, 'T2');
            this.drawBlip(ctx, cx, cy, scale, this.targetDisplay.t3, 'T3');

            this.animationFrameId = requestAnimationFrame(drawRadar);
        };

        this.animationFrameId = requestAnimationFrame(drawRadar);
    },
    beforeUnmount() {
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    },
    methods: {
        drawBlip(ctx, cx, cy, scale, target, label) {
            if (target && target.active && (target.x !== 0 || target.y !== 0)) {
                let pixelX = Math.round(cx + (target.x * scale));
                let pixelY = Math.round(cy - (target.y * scale));

                // Dynamically check against canvas dimensions rather than hardcoded 600/450
                if (pixelX >= 0 && pixelX <= ctx.canvas.width && pixelY >= 0 && pixelY <= ctx.canvas.height) {
                    // Glowing core
                    ctx.shadowBlur = 10;
                    ctx.shadowColor = '#33ff33';
                    ctx.fillStyle = '#ccffcc';
                    ctx.beginPath();
                    ctx.arc(pixelX, pixelY, 4, 0, 2 * Math.PI);
                    ctx.fill();

                    // Outer Ping Ring
                    ctx.shadowBlur = 0;
                    ctx.strokeStyle = '#00ff00';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(pixelX, pixelY, 12, 0, 2 * Math.PI);
                    ctx.stroke();

                    // Target Label
                    ctx.fillStyle = '#00ff00';
                    ctx.font = 'bold 12px Courier New';
                    ctx.fillText(label, pixelX + 16, pixelY - 2);
                }
            }
        }
    }
}
</script>
