const fs = require('fs');
let content = fs.readFileSync('src/ui/connection-panel.ts', 'utf8');

content = content.replace(/const isRemote = mode === 'STA-T';/, "const isRemote = mode === 'STA-T';\n    const isCustom = mode === 'CUSTOM';");
content = content.replace(/ipGroup\.style\.display = isRemote \? 'none' : '';/, "ipGroup.style.display = isRemote ? 'none' : '';");
content = content.replace(/if \(mode === 'AP'\) \{/, "if (isCustom) {\n      if (!this.ipInput.value.startsWith('ws://') && !this.ipInput.value.startsWith('wss://')) {\n        this.ipInput.value = 'ws://192.168.1.10:9001';\n      }\n      this.ipInput.readOnly = false;\n      this.ipInput.placeholder = 'ws://192.168.1.10:9001';\n    } else if (mode === 'AP') {");

fs.writeFileSync('src/ui/connection-panel.ts', content);
