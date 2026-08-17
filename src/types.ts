export type ConnectionMode = 'AP' | 'STA-L' | 'STA-T' | 'CUSTOM';

export interface ConnectionConfig {
  mode: ConnectionMode;
  ip: string;
  token: string;
  serialNumber: string;
  email: string;
  password: string;
}

export interface TurnServerInfo {
  user: string;
  passwd: string;
  realm: string;
}

export interface SdpPayload {
  id: string;
  sdp: string;
  type: 'offer' | 'answer';
  token: string;
  turnserver?: TurnServerInfo;
}

export interface ConNotifyResponse {
  data1: string;
  data2: number;
}

export interface DataChannelMessage {
  type: string;
  topic?: string;
  data?: unknown;
  info?: unknown;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'failed';

export interface ConnectionCallbacks {
  onStateChange: (state: ConnectionState) => void;
  onValidated: () => void;
  onMessage: (msg: DataChannelMessage) => void;
  onVideoTrack: (stream: MediaStream) => void;
  onAudioTrack: (stream: MediaStream) => void;
}
