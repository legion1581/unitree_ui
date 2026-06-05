const fs = require('fs');
let content = fs.readFileSync('src/ui/app.ts', 'utf8');

content = content.replace(/          const gp = navigator.getGamepads\(\)\.find\(g => g && g\.id === this\.gamepadManager\?\.currentState\?\.id\);/, "          const gpMatch = this.activeSourceId.match(/^gamepad:(\\d+)$/);\n          const gpIndex = gpMatch ? parseInt(gpMatch[1], 10) : null;\n          const gp = navigator.getGamepads().find(g => g && (gpIndex !== null ? g.index === gpIndex : g.id === this.gamepadManager?.currentState?.id));");

fs.writeFileSync('src/ui/app.ts', content);
