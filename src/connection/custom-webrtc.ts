import type { ConnectionCallbacks } from '../types';

export class CustomWebRTCConnection {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private callbacks: ConnectionCallbacks;

  constructor(url: string, callbacks: ConnectionCallbacks) {
    this.callbacks = callbacks;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'http://' + url;
    }

    this.callbacks.onStateChange('connecting');
    this.connect(url).catch(err => {
      console.error('[custom-webrtc] connection failed', err);
      this.callbacks.onStateChange('failed');
    });
  }

  private async connect(url: string): Promise<void> {
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    this.dc = this.pc.createDataChannel('control');

    this.dc.onopen = () => {
      console.log('[custom-webrtc] Data channel opened');
      this.callbacks.onStateChange('connected');
      this.callbacks.onValidated();
    };

    this.dc.onclose = () => {
      console.log('[custom-webrtc] Data channel closed');
      this.callbacks.onStateChange('disconnected');
    };

    this.pc.onconnectionstatechange = () => {
      console.log(`[custom-webrtc] connection state: ${this.pc?.connectionState}`);
      if (this.pc?.connectionState === 'failed' || this.pc?.connectionState === 'closed') {
        this.callbacks.onStateChange('disconnected');
      }
    };

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    // Wait for ICE gathering to complete before sending the offer
    await new Promise<void>((resolve) => {
      if (this.pc?.iceGatheringState === 'complete') {
        resolve();
      } else {
        const checkState = () => {
          if (this.pc?.iceGatheringState === 'complete') {
            this.pc.removeEventListener('icegatheringstatechange', checkState);
            resolve();
          }
        };
        this.pc?.addEventListener('icegatheringstatechange', checkState);
      }
    });

    const endpoint = new URL('/offer', url).toString();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sdp: this.pc.localDescription?.sdp,
        type: this.pc.localDescription?.type
      })
    });

    if (!response.ok) {
      throw new Error(`Signaling server returned ${response.status}`);
    }

    const answer = await response.json();
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  send(data: string): void {
    if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(data);
    }
  }

  close(): void {
    if (this.dc) {
      this.dc.close();
      this.dc = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }
}
