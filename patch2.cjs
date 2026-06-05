const fs = require('fs');
let content = fs.readFileSync('src/ui/connection-panel.ts', 'utf8');

content = content.replace(/} else \{(\s+)const ip = this.ipInput.value.trim\(\);/, "} else if (mode === 'CUSTOM') {\n      const ip = this.ipInput.value.trim();\n      this.onConnect({\n        mode,\n        ip,\n        token: '',\n        serialNumber: '',\n        email: '',\n        password: '',\n      });\n    } else {\n      const ip = this.ipInput.value.trim();");

fs.writeFileSync('src/ui/connection-panel.ts', content);
