/**
 * Unitree Cloud API Client
 * Ported from unitree_account_manager/unitree_api.py
 * Uses browser-native fetch() + Vite proxy to bypass CORS/WAF
 */

import forge from 'node-forge';
import { setCachedAesKey } from './aes-key-derive';
import { log } from '../ui/logger';

const API_BASE = '/unitree-api';
const FIRMWARE_CDN = 'https://firmware-cdn.unitree.com';
const SIGN_SECRET = 'XyvkwK45hp5PHfA8';

// Robot families this UI is tested against. The Unitree cloud server keys
// some responses (tutorials, firmware lists, announcements) off the AppName
// header — Go2 has its own dedicated mobile app (AppName='Go2'); G1 ships
// in the Unitree Explorer app which identifies as 'B2' internally
// (RetrofitFactory.java:139 in the decompiled APK). R1 is another
// Explorer-line humanoid that shares AppName='B2' with G1 (verified in the
// Explorer 2.1.2 APK: the R1 series routes through the same B2 account path
// and the same WebRTC topic/command channels), so it is NOT a separate
// account family — it rides on the G1 account and is chosen separately as a
// *connect* target.
export type RobotFamily = 'Go2' | 'G1' | 'R1';
// Account families — cloud-account namespaces used for request signing.
// R1 folds into the G1/Explorer account, so it isn't listed here.
export const ROBOT_FAMILIES: ReadonlyArray<RobotFamily> = ['Go2', 'G1'];
// Connect families — control targets the user can pick on the Connect
// screen. R1 is a distinct humanoid (its own action set + motor figure)
// even though it authenticates through the G1 account.
export const CONNECT_FAMILIES: ReadonlyArray<RobotFamily> = ['Go2', 'G1', 'R1'];
const APP_NAME: Record<RobotFamily, string> = {
  Go2: 'Go2',
  G1:  'B2',
  R1:  'B2',
};
/** Human-readable label for the connect-side family pill. */
export const FAMILY_LABEL: Record<RobotFamily, string> = {
  Go2: 'Go2',
  G1:  'G1',
  R1:  'R1',
};
/** Account-screen label — R1 shares the G1 account, so the account family
 *  pill shows the pair rather than implying they're separate logins. */
export const ACCOUNT_FAMILY_LABEL: Record<RobotFamily, string> = {
  Go2: 'Go2',
  G1:  'G1 & R1',
  R1:  'G1 & R1',
};

/** True for the Explorer-line humanoids (G1 + R1). They share the same
 *  WebRTC topic set, arm/sport command channels, BMS + dual-IMU payload
 *  shapes and lowstate-driven state reading — everything that diverges
 *  from the Go2 quadruped. Family-specific bits that differ *between* G1
 *  and R1 (action set, motor figure, mode→state map) branch on the exact
 *  family instead. */
export function isG1Family(f: RobotFamily): boolean {
  return f === 'G1' || f === 'R1';
}

// Region selects which Unitree cloud endpoint the Vite proxy forwards to.
// Sent as the `X-Unitree-Region` header; the proxy maps it to a hostname and
// strips the header before forwarding upstream.
export type Region = 'global' | 'cn';
export const REGIONS: ReadonlyArray<Region> = ['global', 'cn'];

// Unitree shipped response-body encryption in recent app versions (v1.12+).
// Some endpoints (tutorial/list, app/version, app/version/intro/list) now
// return raw AES-128-CFB128 ciphertext instead of JSON. The key/IV were
// extracted from com/unitree/baselibrary/util/AESUtil.smali — same pair
// also used by the BLE protocol.
const CLOUD_AES_KEY = 'df98b715d5c6ed2b25817b6f2554124a';
const CLOUD_AES_IV  = '2841ae97419c2973296a0d4bdfe19a4f';

function md5(s: string): string {
  return forge.md.md5.create().update(s).digest().toHex();
}

/** AES-128-CFB (128-bit segment) decrypt. Returns raw-byte-string + UTF-8 decoded
 *  string if valid. Never throws — callers check .utf8 to tell success. */
function decryptCloudBody(cipherBytes: Uint8Array): { raw: string; utf8: string | null } {
  const keyBytes = forge.util.hexToBytes(CLOUD_AES_KEY);
  const ivBytes = forge.util.hexToBytes(CLOUD_AES_IV);
  const decipher = forge.cipher.createDecipher('AES-CFB', keyBytes);
  decipher.start({ iv: ivBytes });
  let bin = '';
  for (let i = 0; i < cipherBytes.length; i++) bin += String.fromCharCode(cipherBytes[i]);
  decipher.update(forge.util.createBuffer(bin, 'raw'));
  decipher.finish();
  const raw = decipher.output.getBytes();
  try {
    return { raw, utf8: forge.util.decodeUtf8(raw) };
  } catch {
    return { raw, utf8: null };
  }
}

/** Parse a JWT payload (no signature check) — used for local `exp` inspection. */
function decodeJwtPayload(tok: string): Record<string, unknown> | null {
  try {
    const p = tok.split('.')[1];
    if (!p) return null;
    let s = p.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return JSON.parse(atob(s));
  } catch { return null; }
}

/** Hex preview of the first `max` bytes — used for diagnostic logging. */
function bytesToHex(s: string, max = 48): string {
  let out = '';
  const n = Math.min(s.length, max);
  for (let i = 0; i < n; i++) out += s.charCodeAt(i).toString(16).padStart(2, '0') + ' ';
  if (s.length > max) out += '…';
  return out.trim();
}

/** Globally exposed meta for the most recent request (read by the Debug tab). */
export interface LastResponseMeta {
  path: string;
  bodyBytes: number;
  contentType: string;
  /** Content-Encoding header from the server (gzip / deflate / br / 'none') —
   *  fetch auto-decompresses, so bodyBytes is the *decompressed* size. */
  compression: string;
  decryption: 'none' | 'body-cfb' | 'failed';
  rawPreview: string;
  decryptedPreview: string;
}
let _lastResponseMeta: LastResponseMeta = {
  path: '', bodyBytes: 0, contentType: '', compression: 'none', decryption: 'none',
  rawPreview: '', decryptedPreview: '',
};
export function getLastResponseMeta(): LastResponseMeta { return { ..._lastResponseMeta }; }

/** Platform identity we impersonate. Most endpoints just want a valid header set;
 *  a few (notably GET /app/version) key their response off this. */
export type Platform = 'Android' | 'iOS';

function buildHeaders(
  token = '',
  platform: Platform = 'Android',
  family: RobotFamily = 'Go2',
  region: Region = 'global',
): Record<string, string> {
  const ts = Date.now().toString();
  const nonce = crypto.randomUUID?.()?.replace(/-/g, '') || md5(ts + Math.random());
  const sign = md5(`${SIGN_SECRET}${ts}${nonce}`);

  const common = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'AppTimezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    'AppVersion': '1.12.4',
    'AppLocale': navigator.language?.replace('-', '_') || 'en_US',
    'AppTimestamp': ts,
    'AppNonce': nonce,
    'AppSign': sign,
    'Channel': 'release',
    'Token': token,
    'AppName': APP_NAME[family],
    'X-Unitree-Region': region,
  };

  // DeviceId fields are pipe-joined to match the Unitree Explorer / Go2 apps —
  // the upstream API doesn't validate the value but matching the format keeps
  // server-side analytics clean.
  if (platform === 'iOS') {
    return {
      ...common,
      'DeviceId': 'Apple|iPhone|iPhone15,3|iPhone15,3|17.6.1|34',
      'DevicePlatform': 'iOS',
      'DeviceModel': 'iPhone15,3',
      'SystemVersion': '17.6.1',
    };
  }

  return {
    ...common,
    'DeviceId': 'Samsung|Samsung|SM-S931B|s24|14|34',
    'DevicePlatform': 'Android',
    'DeviceModel': 'SM-S931B',
    'SystemVersion': '34',
  };
}

export interface UserInfo {
  uid: string;
  nickname: string;
  avatar: string;
  email: string;
  mobile: string;
  roles: number[];
}

export interface RobotDevice {
  sn: string;
  alias: string;
  series: string;
  model: string;
  mac: string;
  connIp: string;
  connMode: string;
  online: boolean | null;
  remark: string;
  code: string;
  own: number;
  key: string;
}

export interface FirmwareInfo {
  firmwareId: string;
  packageName: string;
  version: string;
  ownVersion: string;
  description: string;
  download: string;
  md5: string;
  /** Optional: present in v1/firmware/package/upgrade/list responses.
   *  "1" = the cloud already pushed this package to the robot in a
   *  previous session; the install can be triggered without redownload
   *  (G1/Explorer two-step flow). */
  alreadyDownload?: string;
  /** Optional: human-readable warning text (e.g. low-battery caveat). */
  note?: string;
  /** Optional: package size in bytes. */
  storageLimit?: number;
}

/** Progress payload from `firmware/upgrade/progress`.
 *  - `code != 0` is treated as device-offline (matches APK). */
export interface UpgradeProgress {
  code: number;
  current: number;
  total: number;
  message: string;
}

export interface AppVersionInfo {
  VersionName: string;
  VersionCode: number;
  ApkSize: string;
  ApkMd5: string;
  DownloadUrl: string;
  ModifyContent: string;
}

export interface TutorialGroup {
  name: string;
  tutorials: Array<{
    id: string;
    title: string;
    cover: string;
    url: string;
    duration: number;
    description: string;
  }>;
}

export interface ChangelogEntry {
  id: string;
  title: string;
  link: string;
  publishTime: string;
}

interface ApiResponse<T = unknown> {
  code: number;
  data?: T;
  errorMsg?: string;
}

class UnitreeCloudError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

function readLocalEnum<T extends string>(key: string, allowed: ReadonlyArray<T>, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return (v && (allowed as ReadonlyArray<string>).includes(v)) ? (v as T) : fallback;
  } catch { return fallback; }
}

function readPersistedFamily(): RobotFamily {
  try {
    const v = localStorage.getItem('unitree_family');
    if (v === 'Go2' || v === 'G1') return v;
    // Migrate legacy values written before the family list was simplified
    // (anything other than Go2 maps onto the Explorer-line, now keyed as G1).
    if (v === 'Explorer' || v === 'B2' || v === 'R1' || v === 'H1' || v === 'H2') {
      localStorage.setItem('unitree_family', 'G1');
      return 'G1';
    }
  } catch { /* ignore */ }
  return 'Go2';
}

/** Load the connect-side family preference. Independent of the account
 *  family — the user picks this on the Connect screen to drive the
 *  connection UI / control view. Falls back to 'Go2' so first-run users
 *  get a sensible default before they touch the picker. */
function readPersistedConnectFamily(): RobotFamily {
  try {
    const v = localStorage.getItem('unitree_connect_family');
    if (v === 'Go2' || v === 'G1' || v === 'R1') return v;
  } catch { /* ignore */ }
  return 'Go2';
}

export class UnitreeCloudAPI {
  private token = '';
  private refreshToken = '';
  private _lastRefreshedAt: number | null = null;
  user: UserInfo | null = null;

  // Persisted in localStorage. Two independent family slots:
  //   _family        — the *account* family. Picked on the Account-login
  //                    screen and used for cloud-API request signing
  //                    (AppName header). Different families = different
  //                    Unitree apps / different account namespaces.
  //   _connectFamily — the *connect* family. Picked on the Connect screen
  //                    to drive the connection UI + control view. Lets the
  //                    user be logged in as one family but visually pick
  //                    a different connection target.
  private _family: RobotFamily = readPersistedFamily();
  private _connectFamily: RobotFamily = readPersistedConnectFamily();
  private _region: Region = readLocalEnum<Region>('unitree_region', REGIONS, 'global');

  // Subscribers fire on any auth-state mutation (login, logout, token set,
  // session load, refresh). Lets the persistent status icon track login
  // state without polling.
  private authListeners = new Set<() => void>();
  onAuthChange(cb: () => void): () => void {
    this.authListeners.add(cb);
    return () => this.authListeners.delete(cb);
  }
  private emitAuthChange(): void {
    for (const cb of this.authListeners) {
      try { cb(); } catch { /* ignore */ }
    }
  }

  get family(): RobotFamily { return this._family; }
  setFamily(f: RobotFamily): void {
    this._family = f;
    try { localStorage.setItem('unitree_family', f); } catch { /* ignore */ }
  }

  get connectFamily(): RobotFamily { return this._connectFamily; }
  setConnectFamily(f: RobotFamily): void {
    this._connectFamily = f;
    try { localStorage.setItem('unitree_connect_family', f); } catch { /* ignore */ }
  }

  get region(): Region { return this._region; }
  setRegion(r: Region): void {
    this._region = r;
    try { localStorage.setItem('unitree_region', r); } catch { /* ignore */ }
  }

  get isLoggedIn(): boolean {
    return !!this.token;
  }

  get accessToken(): string {
    return this.token;
  }

  /** Unix seconds when the access token was last minted (login or refresh). */
  get lastRefreshedAt(): number | null {
    return this._lastRefreshedAt;
  }

  setAccessToken(token: string): void {
    const wasLoggedIn = !!this.token;
    this.token = token;
    this._lastRefreshedAt = Math.floor(Date.now() / 1000);
    if (wasLoggedIn !== !!this.token) this.emitAuthChange();
    else if (this.token) this.emitAuthChange();
  }

  // ─── Session persistence ─────────────────────────────────────────

  saveSession(): void {
    try {
      localStorage.setItem('unitree_session', JSON.stringify({
        token: this.token,
        refreshToken: this.refreshToken,
        user: this.user,
        lastRefreshedAt: this._lastRefreshedAt,
      }));
    } catch { /* ignore */ }
  }

  loadSession(): boolean {
    try {
      const raw = localStorage.getItem('unitree_session');
      if (!raw) return false;
      const data = JSON.parse(raw);
      this.token = data.token || '';
      this.refreshToken = data.refreshToken || '';
      this.user = data.user || null;
      this._lastRefreshedAt = typeof data.lastRefreshedAt === 'number' ? data.lastRefreshedAt : null;
      if (this.token) this.emitAuthChange();
      return !!this.token;
    } catch {
      return false;
    }
  }

  clearSession(): void {
    const wasLoggedIn = !!this.token;
    this.token = '';
    this.refreshToken = '';
    this.user = null;
    this._lastRefreshedAt = null;
    localStorage.removeItem('unitree_session');
    if (wasLoggedIn) this.emitAuthChange();
  }

  /** Proactively refresh the access token if it's near/past expiry.
   *  Returns false (and clears the session) if the token can't be renewed. */
  async ensureFreshToken(bufferSeconds = 600): Promise<boolean> {
    if (!this.token) return false;
    const payload = decodeJwtPayload(this.token);
    const exp = payload && typeof payload.exp === 'number' ? (payload.exp as number) : null;
    if (exp === null) return true; // unknown exp — rely on 1001 handling mid-flight
    const now = Math.floor(Date.now() / 1000);
    if (exp - now > bufferSeconds) return true;
    if (!this.refreshToken) { this.clearSession(); return false; }
    const ok = await this.doRefreshToken();
    if (!ok) this.clearSession();
    return ok;
  }

  /** Force a refresh regardless of expiry. Used by the "Refresh now"
   *  button on the Account page. Returns true if the API minted a new
   *  pair, false if the refresh token was rejected (session cleared). */
  async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken) { this.clearSession(); return false; }
    const ok = await this.doRefreshToken();
    if (!ok) this.clearSession();
    return ok;
  }

  // ─── HTTP helpers ────────────────────────────────────────────────

  private async request<T>(method: string, path: string, params?: Record<string, string>, platform: Platform = 'Android', familyOverride?: RobotFamily): Promise<ApiResponse<T>> {
    const url = method === 'GET' && params
      ? `${API_BASE}/${path}?${new URLSearchParams(params)}`
      : `${API_BASE}/${path}`;

    const family = familyOverride ?? this._family;
    const t0 = performance.now();

    // Each request is a collapsed devtools group — the header
    // ("[account] GET device/bind/list") shows inline; clicking the
    // chevron expands to reveal the request + response payloads. The
    // body uses .info (not .debug) so it stays visible at Chrome's
    // default level filter once the user opens the group.
    log.account.group(`${method} ${path}`);
    log.account.info('request:', {
      method, path, params: params ?? null, platform, family, region: this._region,
      hasToken: !!this.token, url,
    });

    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers: buildHeaders(this.token, platform, family, this._region),
        body: method === 'POST' && params ? new URLSearchParams(params) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      log.account.warn(`${method} ${path} — network error:`, err);
      log.account.groupEnd();
      throw err;
    }

    const dtMs = Math.round(performance.now() - t0);
    if (!resp.ok) {
      log.account.warn(`${method} ${path} — HTTP ${resp.status} (${dtMs}ms)`);
      log.account.groupEnd();
      throw new Error(`HTTP ${resp.status}`);
    }

    // Upstream returns either plain JSON (most endpoints) or raw AES-128-CFB
    // ciphertext (e.g. the /announcement endpoint since app v1.12). Compressed
    // responses (gzip/deflate/br) are auto-decompressed by fetch because the
    // Vite proxy forwards Content-Encoding; we still capture the original
    // encoding into the meta for display.
    const contentType = resp.headers.get('content-type') || '';
    const contentEncoding = resp.headers.get('content-encoding') || 'none';

    const raw = await resp.arrayBuffer();
    const rawBytes = new Uint8Array(raw);
    const asText = new TextDecoder('utf-8', { fatal: false }).decode(raw);
    const hexPreview = bytesToHex(String.fromCharCode(...rawBytes.slice(0, 32)), 32);

    _lastResponseMeta = {
      path, bodyBytes: rawBytes.length,
      contentType, compression: contentEncoding,
      decryption: 'none',
      rawPreview: hexPreview,
      decryptedPreview: '',
    };

    let json: ApiResponse<T> | null = null;
    try {
      json = JSON.parse(asText);
    } catch {
      // Body wasn't plain JSON — try AES-CFB decrypt with the hardcoded key/IV
      const r = decryptCloudBody(rawBytes);
      if (r.utf8) {
        try {
          json = JSON.parse(r.utf8);
          _lastResponseMeta.decryption = 'body-cfb';
          _lastResponseMeta.decryptedPreview = r.utf8.slice(0, 400);
          log.account.debug(`${path}: AES-CFB decrypted (${rawBytes.length} bytes ciphertext)`);
        } catch { /* fall through to failure */ }
      }
      if (!json) {
        const decHex = bytesToHex(r.raw, 32);
        _lastResponseMeta.decryption = 'failed';
        _lastResponseMeta.decryptedPreview = `(non-UTF-8) hex: ${decHex}`;
        log.account.warn(`${path}: decode failed. raw: ${hexPreview} · aes-cfb: ${decHex}`);
        log.account.groupEnd();
        throw new Error(`Response decode failed (plain + AES-CFB). Body hex: ${hexPreview}`);
      }
    }

    const result = json as ApiResponse<T>;
    log.account.info('response:', {
      httpStatus: resp.status,
      durationMs: dtMs,
      bytes: rawBytes.length,
      contentType,
      compression: contentEncoding,
      decryption: _lastResponseMeta.decryption,
      code: result.code,
      errorMsg: result.errorMsg ?? null,
      data: result.data,
    });
    if (result.code !== 100) {
      // API-level failure (auth, validation, server). Warn so the
      // user spots it even at 'warn' verbosity without expanding the
      // group.
      log.account.warn(`${method} ${path} — api code=${result.code}${result.errorMsg ? ' ' + result.errorMsg : ''}`);
    }
    log.account.groupEnd();

    // Auto-refresh on token expiry
    if (result.code === 1001 && this.refreshToken) {
      const refreshed = await this.doRefreshToken();
      if (refreshed) return this.request(method, path, params, platform);
    }

    return result;
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const resp = await this.request<T>('GET', path, params);
    if (resp.code !== 100) throw new UnitreeCloudError(resp.code, resp.errorMsg || `Error ${resp.code}`);
    return resp.data as T;
  }

  async post<T>(path: string, params?: Record<string, string>, familyOverride?: RobotFamily): Promise<T> {
    const resp = await this.request<T>('POST', path, params, 'Android', familyOverride);
    if (resp.code !== 100) throw new UnitreeCloudError(resp.code, resp.errorMsg || `Error ${resp.code}`);
    return resp.data as T;
  }

  private async doRefreshToken(): Promise<boolean> {
    try {
      const resp = await this.request<{ accessToken: string; refreshToken: string }>('POST', 'token/refresh', {
        refreshToken: this.refreshToken,
      });
      if (resp.code === 100 && resp.data) {
        this.token = resp.data.accessToken;
        this.refreshToken = resp.data.refreshToken || this.refreshToken;
        this._lastRefreshedAt = Math.floor(Date.now() / 1000);
        this.saveSession();
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  // ─── Auth ────────────────────────────────────────────────────────

  async loginEmail(email: string, password: string): Promise<UserInfo> {
    const resp = await this.request<{ accessToken: string; refreshToken: string; user: UserInfo }>('POST', 'login/email', {
      email,
      password: md5(password),
    });
    if (resp.code !== 100) throw new UnitreeCloudError(resp.code, resp.errorMsg || 'Login failed');
    this.token = resp.data!.accessToken;
    this.refreshToken = resp.data!.refreshToken || '';
    this.user = resp.data!.user || null;
    this._lastRefreshedAt = Math.floor(Date.now() / 1000);
    this.saveSession();
    this.emitAuthChange();
    return this.user!;
  }

  async sendEmailCaptcha(email: string): Promise<void> {
    await this.post('captcha/email', { email });
  }

  /** Fetch a fresh image-captcha session for registration.
   *  `code` is an opaque session token the server uses to look up which
   *  puzzle was issued; `svg` is the raw SVG markup of the 4-character
   *  distorted-text image, ready to inject into a container's innerHTML.
   *  See APK LoginApi.getImageCode() / RegisterFragment.onCodeGetResult(). */
  async getImageCaptcha(): Promise<{ code: string; svg: string }> {
    return this.get<{ code: string; svg: string }>('captcha');
  }

  /** Email registration flow. Matches the official `register/email`
   *  contract from the decompiled APK: the server expects both halves of
   *  the captcha pair (`code` = session id from getImageCaptcha; `captcha`
   *  = the 4-char string the user typed reading the SVG) plus three empty
   *  company fields (always blank for personal accounts). On success the
   *  response carries an access+refresh token — the user is logged in
   *  immediately, no separate login call. */
  async registerEmail(
    email: string,
    password: string,
    captchaCode: string,
    captchaSolution: string,
  ): Promise<UserInfo> {
    const resp = await this.request<{ accessToken: string; refreshToken: string; user: UserInfo }>('POST', 'register/email', {
      email,
      password: md5(password),
      code: captchaCode,
      captcha: captchaSolution,
      companyName: '',
      companyContact: '',
      companyAccountRemark: '',
      region: '',
    });
    if (resp.code !== 100) throw new UnitreeCloudError(resp.code, resp.errorMsg || 'Registration failed');
    this.token = resp.data!.accessToken;
    this.refreshToken = resp.data!.refreshToken || '';
    this.user = resp.data!.user || null;
    this._lastRefreshedAt = Math.floor(Date.now() / 1000);
    this.saveSession();
    this.emitAuthChange();
    return this.user!;
  }

  async resetPassword(email: string, captcha: string, newPassword: string): Promise<void> {
    await this.post('oauth/email/password/reset', { email, captcha, password: md5(newPassword) });
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.post('user/password/update', { oldPassword: md5(oldPassword), password: md5(newPassword) });
  }

  logout(): void {
    this.clearSession();
  }

  /** Permanently destroy the authenticated user's Unitree account.
   *  Mirrors the official APK: bare `POST user/destroy` with no body —
   *  the server identifies the account from the bearer token alone.
   *  No password re-entry, no captcha, no soft-delete window. After a
   *  100/true response the session is cleared locally too.
   *  See LoginApi.deleteUser() in the decompiled G1 1.9.3 APK. */
  async deleteAccount(): Promise<void> {
    await this.post('user/destroy');
    this.clearSession();
  }

  // ─── User ────────────────────────────────────────────────────────

  async getUserInfo(): Promise<UserInfo> {
    this.user = await this.get<UserInfo>('user/info');
    this.saveSession();
    this.emitAuthChange();
    return this.user;
  }

  async updateUserInfo(fields: { nickname?: string; avatar?: string }): Promise<void> {
    await this.post('user/info/update', fields as Record<string, string>);
  }

  // ─── Devices ─────────────────────────────────────────────────────

  async listDevices(): Promise<RobotDevice[]> {
    const devices = (await this.get<RobotDevice[]>('device/bind/list')) || [];
    // Prime the local AES-128 key cache from the cloud-stored keys so the
    // WebRTC data2=3 path can pick them up without prompting the user.
    for (const d of devices) {
      if (d.sn && d.key && d.key.trim()) setCachedAesKey(d.sn, d.key.trim());
    }
    return devices;
  }

  /**
   * `device/bind` — initial bind for a new robot. The `sn` field carries the
   * RSA-encrypted SN (caller wraps it via `rsaEncryptSn`); the other fields
   * are plain. `extData` is the 344-char base64 RSA blob from the BT popup;
   * the cloud uses it on this initial-bind path to populate `dev.key` (the
   * 16-byte AES-128 key for `data2=3`). Subsequent `device/bind/list` calls
   * return `dev.key` directly.
   */
  async bindDevice(snEncrypted: string, mac: string, alias: string, remark: string, extData: string): Promise<void> {
    await this.post('device/bind', {
      sn: snEncrypted,
      mac,
      alias,
      remark,
      extData,
    });
  }

  /**
   * `device/unbind` — same RSA-encrypted-SN convention as bind. Caller wraps
   * the SN via `rsaEncryptSn` before calling.
   */
  async unbindDevice(snEncrypted: string): Promise<void> {
    await this.post('device/unbind', { sn: snEncrypted });
  }

  /**
   * `device/bindExtData` — re-upload the BLE V3 F2 RSA-wrapped key blob
   * for a device that's *already* bound, and receive the freshly-derived
   * 16-byte AES-128 key (32 hex chars) in the response. Mirrors the G1
   * Explore APK's `MainRepository.bindExtData` (G1 1.5.1+ / Go2 1.1.15+).
   *
   * `snEncrypted` follows the same RSA-PKCS1v15 convention as `device/bind`
   * — caller wraps it via `rsaEncryptSn`. `extData` is the raw 344-char
   * base64 blob from the BLE F2 reassembly (chunked, MTU=104 required).
   *
   * Optional `family` override picks the AppName header (Go2 vs B2) per
   * call rather than using the global pill, so refreshing a G1 key while
   * the user is logged in as Go2 family (or vice versa) still matches the
   * device's actual series. Pass `dev.series` from the caller — both
   * "Go2" and "G1" map directly onto RobotFamily.
   */
  async bindExtData(snEncrypted: string, extData: string, family?: RobotFamily): Promise<string> {
    return (await this.post<string>('device/bindExtData', {
      extData,
      sn: snEncrypted,
    }, family)) || '';
  }

  async getDeviceOnlineStatus(sn: string): Promise<boolean> {
    return !!(await this.get<boolean>('device/online/status', { sn }));
  }

  /** Cloud-side RSA public key used to wrap the SN for bind / unbind. */
  async getPubKey(): Promise<string> {
    return (await this.get<string>('system/pubKey')) || '';
  }

  async updateDevice(sn: string, alias: string, remark = ''): Promise<void> {
    await this.post('device/update', { sn, alias, remark });
  }

  async getDeviceNetwork(sn: string): Promise<string> {
    return (await this.get<string>('device/network', { sn })) || '';
  }

  async getDeviceLocation(sn: string): Promise<{ gpsEnable: number; latitude: string; longitude: string; gpsTimestamp: string }> {
    return await this.get('device/location', { sn });
  }

  async updateDeviceGps(sn: string, enable: boolean): Promise<void> {
    await this.post('device/location/updateStatus', { sn, gpsEnable: enable ? '1' : '0' });
  }

  // ─── Sharing ─────────────────────────────────────────────────────

  async shareDevice(sn: string, account: string): Promise<void> {
    await this.post('device/share/add', { sn, account, remark: '' });
  }

  async listShares(sn: string): Promise<Array<{ uid: string; nickname: string; shareUid: string }>> {
    return (await this.post('device/share/list', { sn })) || [];
  }

  async deleteShare(sn: string, shareUid: string): Promise<void> {
    await this.post('device/share/del', { sn, shareUid });
  }

  // ─── Firmware ────────────────────────────────────────────────────

  async listFirmwareUpdates(sn: string): Promise<FirmwareInfo[]> {
    return (await this.post<FirmwareInfo[]>('v1/firmware/package/upgrade/list', { sn })) || [];
  }

  async getFirmwareVersion(sn: string): Promise<string> {
    return (await this.post<string>('firmware/package/version', { sn })) || '';
  }

  getFirmwareDownloadUrl(downloadPath: string): string {
    if (downloadPath.startsWith('http')) return downloadPath;
    // The API returns `download` as an unencoded path (e.g. ".../package_..._G1_Edu+_...upk")
    // while the parallel `packageName` field is URL-encoded ("..._G1_Edu%2B_..."). The CDN
    // routes on the encoded form — fetching the raw `+` returns 404 because `+` decodes to
    // a space in URL parsers. Percent-encode each path segment (preserving the slashes).
    const encoded = downloadPath.split('/').map(s => encodeURIComponent(s)).join('/');
    return `${FIRMWARE_CDN}${encoded}`;
  }

  // ─── OTA: server-orchestrated firmware upgrade ───────────────────
  // The cloud handles the heavy lifting — these endpoints just kick off
  // the job (or resume a previous one) and let the app poll progress.
  // Two paths exist (mirrors the APK):
  //   * Go2 / quadruped:   single-shot `firmware/package/upgrade`
  //   * G1 / Explorer:    two-step `firmware/package/download` then
  //                       `firmware/package/install` (with a 500/1000
  //                       progress boundary between phases).

  /** Single-shot upgrade kick (Go2). Returns the updateId to poll on. */
  async startFirmwareUpgrade(sn: string, firmwareId: string): Promise<string> {
    const r = await this.post<{ updateId: string }>('firmware/package/upgrade', { sn, firmwareId });
    return r.updateId;
  }

  /** Two-step phase 1 (G1/Explorer): cloud pushes the package to the robot. */
  async startFirmwareDownload(sn: string, firmwareId: string): Promise<string> {
    const r = await this.post<{ updateId: string }>('firmware/package/download', { sn, firmwareId });
    return r.updateId;
  }

  /** Two-step phase 2 (G1/Explorer): robot applies the previously-downloaded package. */
  async startFirmwareInstall(sn: string, firmwareId: string): Promise<string> {
    const r = await this.post<{ updateId: string }>('firmware/package/install', { sn, firmwareId });
    return r.updateId;
  }

  /** Poll for OTA progress. `code != 0` means the cloud lost the device. */
  async getUpgradeProgress(updateId: string): Promise<UpgradeProgress> {
    return this.get<UpgradeProgress>('firmware/upgrade/progress', { updateId });
  }

  /** Resume anchor: returns the active updateId (or '' if nothing is running)
   *  for the given robot. Lets the UI re-attach to an in-flight job after
   *  app restart / reconnect. */
  async getCurrentUpgradeTask(sn: string): Promise<string> {
    try {
      const r = await this.post<string>('firmware/upgrade/task/current', { sn });
      return r || '';
    } catch { return ''; }
  }

  // (device/online/status liveness probe is already exposed above as
  // `getDeviceOnlineStatus(sn)`; the OTA controller uses it directly.)

  // ─── App info ────────────────────────────────────────────────────

  async getAppVersion(platform: Platform = 'Android'): Promise<AppVersionInfo | null> {
    try {
      // Send matching DevicePlatform header + query param so the server returns
      // the version info for the requested store (APK vs App Store).
      const resp = await this.request<string>('GET', 'app/version', { platform }, platform);
      if (resp.code !== 100) return null;
      const raw = resp.data;
      if (typeof raw === 'string') return JSON.parse(raw);
      return raw as unknown as AppVersionInfo;
    } catch { return null; }
  }

  /**
   * Fetch tutorial videos. The cloud filters by (series, model) tuple —
   * decompiled from the Explore APK at
   *   com/unitree/godog/data/repository/AppRepository.getTutorialList()
   * which calls GET tutorial/list?appName=<currentDog.series>&type=<currentDog.model>.
   * Empty model returns the generic legacy set, so G1-specific tutorials
   * only show up when `type` is the actual device model (e.g. "day" for
   * G1 EDU).
   *
   * Caller can pass an explicit `model`; otherwise we look up the user's
   * first bound device matching the account family and use its model. As
   * a last-resort fallback for G1 (no device bound yet) we default to
   * "day", which covers the common G1 EDU variant.
   */
  async getTutorials(model?: string): Promise<TutorialGroup[]> {
    // appName here is the device *series* (the value the cloud filters on),
    // NOT the AppName HTTP header (which is "B2" for the whole Explorer
    // line). The APK passes currentDog.series directly — for G1 robots
    // that's literally "G1", and for Go2 it's "Go2".
    let appName: string = this._family;
    let type = model ?? '';
    if (model === undefined && this._family === 'G1') {
      try {
        const devs = await this.listDevices();
        const g1 = devs.find(d => d.series === 'G1');
        if (g1) {
          appName = g1.series;
          type = g1.model || 'day';
        } else {
          type = 'day';
        }
      } catch {
        type = 'day';
      }
    }
    try {
      const flat = await this.get<TutorialGroup['tutorials']>('tutorial/list', { appName, type });
      if (Array.isArray(flat) && flat.length) return [{ name: 'Tutorials', tutorials: flat }];
    } catch { /* ignore */ }
    return [];
  }

  /**
   * User-manual web links (Robot / Remote Control / Battery Charger). Unlike
   * the tutorial list these are NOT a cloud list endpoint — the app's
   * ManualActivity builds deterministic marketing.unitree.com pages whose path
   * carries the device series + language:
   *   https://marketing.unitree.com/article/<lang>/<series>/<page>.html
   * (the app stores a "/H1/" template and string-replaces "/H1/" → "/<series>/"
   * in startSystemWeb).
   *   lang   : cn → "zh", otherwise "en"
   *   series : Go2 → "Go2"; G1 → "G1-D" for the EDU/D variant (model "d"/"day"
   *            or a couple of known SNs), else "G1"
   *   pages  : User_Manual.html, Remote_Control.html, Battery_Charger.html
   */
  async getManualLinks(): Promise<Array<{ title: string; url: string }>> {
    const lang = this._region === 'cn' ? 'zh' : 'en';
    let series: string = this._family; // "Go2" | "G1"
    if (this._family === 'G1') {
      try {
        const devs = await this.listDevices();
        const g1 = devs.find((d) => d.series === 'G1');
        const model = (g1?.model || '').toLowerCase();
        if (model === 'd' || model === 'day') series = 'G1-D';
      } catch { /* fall back to plain G1 */ }
    }
    const base = `https://marketing.unitree.com/article/${lang}/${series}`;
    return [
      { title: 'Robot', url: `${base}/User_Manual.html` },
      { title: 'Remote Control', url: `${base}/Remote_Control.html` },
      { title: 'Battery Charger', url: `${base}/Battery_Charger.html` },
    ];
  }

  async getChangelog(): Promise<ChangelogEntry[]> {
    try {
      const resp = await this.get<{ items: ChangelogEntry[] }>('app/version/intro/list', { lastId: '0' });
      return resp?.items || [];
    } catch { return []; }
  }

  async getNotices(): Promise<Array<{ title: string; content: string; createTime: string }>> {
    try { return (await this.get('app/notice/list')) || []; } catch { return []; }
  }

  // ─── Wallet / Flow ───────────────────────────────────────────────

  async getDeviceWallet(sn: string): Promise<unknown> {
    return await this.post('device/wallet', { sn });
  }

  async getDataUsage(sn: string, year: number, month: number): Promise<unknown> {
    return await this.get('device/flow/usage', { sn, year: String(year), month: String(month) });
  }

  // ─── Debug / Raw ─────────────────────────────────────────────────

  async rawRequest(method: string, path: string, params?: Record<string, string>, platform: Platform = 'Android'): Promise<ApiResponse> {
    return await this.request(method, path, params, platform);
  }
}

// Singleton
export const cloudApi = new UnitreeCloudAPI();
