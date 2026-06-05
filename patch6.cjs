const fs = require('fs');
let content = fs.readFileSync('src/ui/app.ts', 'utf8');

const replaceStr = `      // Default: on-screen joysticks.
      if (this.connectionConfig?.mode === 'CUSTOM') {
        const { lx, ly, rx, ry } = this.joystickState;

        const payload = {
          seq: this.customSeq++,
          t_ms: Date.now(),
          deadman: false, // on-screen joystick has no deadman
          vx: ly, // ly is already inverted?
          vy: lx,
          wz: rx,
          mode: this.customMode,
        };

        if (this.webrtc && typeof (this.webrtc as any).send === 'function') {
          (this.webrtc as any).send(JSON.stringify(payload));
        }
        return;
      }
      const { lx, ly, rx, ry } = this.joystickState;`;

content = content.replace(/      \/\/ Default: on-screen joysticks\.\n      const \{ lx, ly, rx, ry \} = this\.joystickState;/, replaceStr);

fs.writeFileSync('src/ui/app.ts', content);
