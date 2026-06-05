import type { ConnectionCallbacks } from '../types';

export class CustomWebSocketConnection {
  private ws: WebSocket | null = null;
  private callbacks: ConnectionCallbacks;

  constructor(url: string, callbacks: ConnectionCallbacks) {
    this.callbacks = callbacks;
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = 'ws://' + url;
    }

    this.ws = new WebSocket(url);
    this.callbacks.onStateChange('connecting');

    this.ws.onopen = () => {
      this.callbacks.onStateChange('connected');
      // Bypass WebRTC validation logic and just trigger onValidated
      this.callbacks.onValidated();
    };

    this.ws.onclose = () => {
      this.callbacks.onStateChange('disconnected');
    };

    this.ws.onerror = (err) => {
      console.error('[custom-ws] WebSocket error', err);
      this.callbacks.onStateChange('disconnected');
    };
  }

  send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
