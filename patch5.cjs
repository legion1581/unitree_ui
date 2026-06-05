const fs = require('fs');
let content = fs.readFileSync('src/ui/app.ts', 'utf8');

const replaceStr = `  private customSeq = 0;
  private customMode = 'sleep';

  private startJoystickLoop(): void {
    this.joystickTimer = setInterval(() => {
      // Gamepad active → publish its state on the same 20 Hz cadence.
      if (this.activeSourceId?.startsWith('gamepad:') && this.gamepadManager?.currentState) {
        if (this.connectionConfig?.mode === 'CUSTOM') {
          // Custom WebSocket payload
          const gp = navigator.getGamepads().find(g => g && g.id === this.gamepadManager?.currentState?.id);
          if (gp) {
            const vx = gp.axes.length > 1 ? -gp.axes[1] : 0;
            const vy = gp.axes.length > 0 ? gp.axes[0] : 0;
            const wz = gp.axes.length > 2 ? gp.axes[2] : 0;
            const deadman = gp.axes.length > 4 ? gp.axes[4] > 0.0 : false;

            const b = gp.buttons;
            if (b[0]?.pressed) this.customMode = 'sleep';
            if (b[1]?.pressed) this.customMode = 'stand';
            if (b[2]?.pressed) this.customMode = 'move';

            const payload = {
              seq: this.customSeq++,
              t_ms: Date.now(),
              deadman,
              vx,
              vy,
              wz,
              mode: this.customMode,
            };

            if (this.webrtc && typeof (this.webrtc as any).send === 'function') {
              (this.webrtc as any).send(JSON.stringify(payload));
            }
          }
          return;
        }

        const { lx, ly, rx, ry, keys } = this.gamepadManager.currentState;
        const inUse = lx !== 0 || ly !== 0 || rx !== 0 || ry !== 0 || keys !== 0;`;

content = content.replace(/  private startJoystickLoop\(\): void \{\n    this\.joystickTimer = setInterval\(\(\) => \{\n      \/\/ Gamepad active → publish its state on the same 20 Hz cadence\.\n      if \(this\.activeSourceId\?\.startsWith\('gamepad:'\) && this\.gamepadManager\?\.currentState\) \{\n        const \{ lx, ly, rx, ry, keys \} = this\.gamepadManager\.currentState;\n        const inUse = lx !== 0 \|\| ly !== 0 \|\| rx !== 0 \|\| ry !== 0 \|\| keys !== 0;/, replaceStr);

fs.writeFileSync('src/ui/app.ts', content);
