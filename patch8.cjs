const fs = require('fs');
let content = fs.readFileSync('src/ui/app.ts', 'utf8');

content = content.replace(/          const gp = navigator\.getGamepads\(\)\.find\(g => g && \(gpIndex !== null \? g\.index === gpIndex : g\.id === this\.gamepadManager\?\.currentState\?\.id\)\);/, "          // activeSourceId maps to 'gamepad:0', 'gamepad:1' etc.\n          const gp = navigator.getGamepads().find(g => g && (gpIndex !== null ? g.index === gpIndex : g.id === this.gamepadManager?.currentState?.id));");

fs.writeFileSync('src/ui/app.ts', content);
