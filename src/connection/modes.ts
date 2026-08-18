import type { ConnectionMode } from '../types';

export const MODE_LABELS: Record<ConnectionMode, string> = {
  'STA-L': 'Local Network',
  'AP': 'Access Point (Direct)',
  'STA-T': 'Remote',
};

export const DEFAULT_AP_IP = '192.168.123.161';
export const LOCAL_PORT = 9991;
export const LOCAL_OFFER_PORT = 8081;
export const REMOTE_API_BASE = 'https://global-robot-api.unitree.com';
