const fs = require('fs');
let content = fs.readFileSync('src/ui/app.ts', 'utf8');

content = content.replace(/this\.dataHandler = new DataChannelHandler\(this\.webrtc, callbacks\);\n      \} else \{\n        this\.dataHandler = null;\n      \}\n      \/\/ Wire the error-message handler immediately — the robot sends its first\n      \/\/ "errors" snapshot the same tick as "Validation Ok.", which is BEFORE\n      \/\/ the onValidated callback runs. Don't wait for validation here.\n      this\.dataHandler\.onErrorMessage = \(type, data\) => this\.errorStore\.applyWireMessage\(type, data\);/,
  "this.dataHandler = new DataChannelHandler(this.webrtc as WebRTCConnection, callbacks);\n      } else {\n        this.dataHandler = null;\n      }\n      // Wire the error-message handler immediately — the robot sends its first\n      // \"errors\" snapshot the same tick as \"Validation Ok.\", which is BEFORE\n      // the onValidated callback runs. Don't wait for validation here.\n      if (this.dataHandler) {\n        this.dataHandler.onErrorMessage = (type, data) => this.errorStore.applyWireMessage(type, data);\n      }");

fs.writeFileSync('src/ui/app.ts', content);
