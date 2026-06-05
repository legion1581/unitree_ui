const fs = require('fs');
let content = fs.readFileSync('src/ui/app.ts', 'utf8');

content = content.replace(/import \{ connectLocal \} from '\.\.\/connection\/local-connector';/, "import { connectLocal } from '../connection/local-connector';\nimport { CustomWebSocketConnection } from '../connection/custom-ws';");

content = content.replace(/      } else \{\n        if \(\!config\.ip\) throw new Error\('IP address required'\);\n        this\.webrtc = await connectLocal\(config\.ip, config\.mode, callbacks, onStep, \{\n          sn: config\.serialNumber,\n          promptKey: \(sn, opts\) => promptAesKey\(sn, opts\),\n        \}\);\n      \}\n      this\.dataHandler = new DataChannelHandler\(this\.webrtc, callbacks\);/,
  "      } else if (config.mode === 'CUSTOM') {\n        if (!config.ip) throw new Error('IP address required');\n        this.webrtc = new CustomWebSocketConnection(config.ip, callbacks) as any;\n      } else {\n        if (!config.ip) throw new Error('IP address required');\n        this.webrtc = await connectLocal(config.ip, config.mode as 'STA-L' | 'AP', callbacks, onStep, {\n          sn: config.serialNumber,\n          promptKey: (sn, opts) => promptAesKey(sn, opts),\n        });\n      }\n      if (config.mode !== 'CUSTOM') {\n        this.dataHandler = new DataChannelHandler(this.webrtc, callbacks);\n      } else {\n        this.dataHandler = null;\n      }");

fs.writeFileSync('src/ui/app.ts', content);
