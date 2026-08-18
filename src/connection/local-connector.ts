import type { ConNotifyResponse, ConnectionCallbacks, SdpPayload } from '../types';
import { aesEncrypt, aesDecrypt, aesGcmDecrypt, generateAesKey, hexToBytes } from '../crypto/aes';
import { loadPublicKey, rsaEncrypt } from '../crypto/rsa';
import { LOCAL_PORT, LOCAL_OFFER_PORT } from './modes';
import { WebRTCConnection } from './webrtc';
import { cloudApi } from '../api/unitree-cloud';
import { getCachedAesKey, setCachedAesKey, clearCachedAesKey } from '../api/aes-key-derive';
import { log } from '../ui/logger';

// Log prefix follows the active family at call time so a Go2 vs G1
// connection attempt is distinguishable in DevTools.
const tag = (): string => `[${cloudApi.connectFamily.toLowerCase()}]`;

export interface AesKeyPromptOptions {
  /** True when the previous key (cached or just-entered) failed to decrypt
   *  the con_notify payload — the modal should surface that to the user. */
  previousKeyFailed?: boolean;
}
export type AesKeyPrompter = (sn: string, opts?: AesKeyPromptOptions) => Promise<string>;

function proxyUrl(path: string): string {
  return `/robot-api${path}`;
}

function proxyHeaders(host: string, contentType?: string): Record<string, string> {
  const headers: Record<string, string> = { 'X-Robot-Host': host };
  if (contentType) headers['Content-Type'] = contentType;
  return headers;
}

function extractPathEnding(data1: string): string {
  const tail = data1.slice(-10);
  const lookup = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  let path = '';
  for (let i = 0; i < tail.length; i += 2) {
    const ch = tail[i + 1];
    const idx = lookup.indexOf(ch);
    path += idx >= 0 ? idx.toString() : '0';
  }
  return path;
}

async function decryptData1(
  resp: ConNotifyResponse,
  sn: string,
  promptKey?: AesKeyPrompter,
  onStep?: (msg: string) => void,
): Promise<string> {
  if (resp.data2 === 2) {
    return await aesGcmDecrypt(resp.data1);
  }
  if (resp.data2 === 3) {
    // Per-device AES-128 key required (G1 ≥ 1.5.1). Pull from cache first;
    // if missing or wrong, prompt and retry. We give the user up to 3
    // attempts before bubbling up the failure — a wrong key flushes the
    // cache so the next visit doesn't auto-load the bad value.
    const MAX_ATTEMPTS = 3;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const fromCache = attempt === 0 && sn ? getCachedAesKey(sn) : null;
      let aesHex = fromCache;
      if (!aesHex) {
        if (!promptKey) {
          throw new Error('data2=3 needs an AES-128 key. Open Account → device tile → "AES Key" to derive one for this SN.');
        }
        aesHex = (await promptKey(sn, { previousKeyFailed: lastErr !== null })).trim();
        if (!aesHex) throw new Error('AES-128 key required to decrypt con_notify');
        if (sn) setCachedAesKey(sn, aesHex);
        const note = lastErr ? 'AES-128 key (prompted again, previous key failed)' : 'AES-128 key (prompted)';
        log.webrtc.info(`${tag()} ${note} for SN ${sn || '<unknown>'} — cached for next time, key=${aesHex}`);
        onStep?.(`${note} — cached for SN ${sn || '<unknown>'}`);
      } else {
        log.webrtc.info(`${tag()} AES-128 key loaded from localStorage cache for SN ${sn}, key=${aesHex}`);
        onStep?.(`AES-128 key from localStorage cache (SN ${sn})`);
      }
      try {
        return await aesGcmDecrypt(resp.data1, hexToBytes(aesHex));
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        log.webrtc.warn(`${tag()} AES-128 decrypt failed for SN ${sn || '<unknown>'} (${lastErr.message}) — flushing cached key, will reprompt`);
        // The key (cached or just-entered) is wrong — flush it so a
        // fresh attempt can collect a different one. Loop will reprompt
        // unless we've exhausted attempts.
        if (sn) clearCachedAesKey(sn);
      }
    }
    throw lastErr ?? new Error('AES-128 decrypt failed after retries');
  }
  return resp.data1;
}

async function detectPort(ip: string): Promise<'new' | 'old'> {
  // Try port 9991 first (newer firmware), then 8081 (older firmware)
  let port9991Status = 'untried';
  let port8081Status = 'untried';

  try {
    const resp = await fetch(proxyUrl('/con_notify'), {
      method: 'POST',
      headers: proxyHeaders(`${ip}:${LOCAL_PORT}`),
      signal: AbortSignal.timeout(3000),
    });
    port9991Status = `HTTP ${resp.status}`;
    if (resp.ok) {
      log.webrtc.info(`${tag()} Port ${LOCAL_PORT} available (new method)`);
      return 'new';
    }
  } catch (e) {
    port9991Status = e instanceof Error ? e.message : 'error';
  }

  try {
    const resp = await fetch(proxyUrl('/'), {
      method: 'HEAD',
      headers: proxyHeaders(`${ip}:${LOCAL_OFFER_PORT}`),
      signal: AbortSignal.timeout(3000),
    });
    port8081Status = `HTTP ${resp.status}`;
    // Even a 404 means the port is reachable
    if (resp.status !== 502) {
      log.webrtc.info(`${tag()} Port ${LOCAL_OFFER_PORT} available (old method)`);
      return 'old';
    }
  } catch (e) {
    port8081Status = e instanceof Error ? e.message : 'error';
  }

  log.webrtc.warn(`${tag()} Port probe results — ${ip}:${LOCAL_PORT}: ${port9991Status} | ${ip}:${LOCAL_OFFER_PORT}: ${port8081Status}`);
  throw new Error(
    `Robot not responding at ${ip} — port ${LOCAL_PORT}: ${port9991Status}, port ${LOCAL_OFFER_PORT}: ${port8081Status}. Check browser console (F12) for details.`
  );
}

export async function connectLocal(
  ip: string,
  mode: 'AP' | 'STA-L',
  callbacks: ConnectionCallbacks,
  onStep?: (msg: string) => void,
  opts: { sn?: string; promptKey?: AesKeyPrompter } = {},
): Promise<WebRTCConnection> {
  log.webrtc.info(`${tag()} Connecting to ${ip} in ${mode} mode...`);

  onStep?.(`Detecting robot at ${ip}...`);
  const method = await detectPort(ip);
  log.webrtc.info(`${tag()} Using ${method} method`);

  onStep?.('Creating WebRTC offer...');
  const webrtc = new WebRTCConnection(callbacks);
  const sdpString = await webrtc.createOffer();
  log.webrtc.info(`${tag()} Created WebRTC offer (${sdpString.length} bytes)`);

  const id = mode === 'AP' ? 'abcd' : 'STA_localNetwork';
  const sdpPayload: SdpPayload = {
    id,
    sdp: sdpString,
    type: 'offer',
    token: '',
  };

  try {
    let answerSdp: string;

    onStep?.('Exchanging SDP with robot...');
    if (method === 'new') {
      answerSdp = await exchangeSdpNew(ip, sdpPayload, opts.sn ?? '', opts.promptKey, onStep);
    } else {
      answerSdp = await exchangeSdpOld(ip, sdpPayload);
    }

    if (answerSdp === 'reject') {
      webrtc.close();
      throw new Error('Device rejected connection — another client may be connected');
    }

    log.webrtc.info(`${tag()} Received answer SDP (${answerSdp.length} bytes)`);
    // Concise media summary (which m-lines the robot negotiated + direction) —
    // enough to spot a missing/odd audio or video line without dumping the SDP.
    const mediaLines = answerSdp.split('\n')
      .map(l => l.trim())
      .filter(l => /^m=(audio|video)|^a=(sendrecv|sendonly|recvonly|inactive)$/.test(l));
    log.webrtc.debug(`${tag()} media:`, mediaLines.join(' | ') || '(none)');

    onStep?.('Setting remote description...');
    await webrtc.setAnswer(answerSdp);
    log.webrtc.info(`${tag()} Remote description set, waiting for connection...`);

    return webrtc;
  } catch (err) {
    webrtc.close();
    throw err;
  }
}

async function exchangeSdpNew(
  ip: string,
  payload: SdpPayload,
  sn: string,
  promptKey?: AesKeyPrompter,
  onStep?: (msg: string) => void,
): Promise<string> {
  const host = `${ip}:${LOCAL_PORT}`;

  // Step 1: con_notify — get public key
  log.webrtc.info(`${tag()} Sending con_notify to ${host}...`);
  const notifyResp = await fetch(proxyUrl('/con_notify'), {
    method: 'POST',
    headers: proxyHeaders(host),
  });

  if (!notifyResp.ok) {
    throw new Error(`con_notify failed: HTTP ${notifyResp.status}`);
  }

  const notifyB64 = await notifyResp.text();
  const notifyJson: ConNotifyResponse = JSON.parse(atob(notifyB64));
  log.webrtc.info(`${tag()} con_notify response: data2=${notifyJson.data2}, data1 length=${notifyJson.data1.length}`);

  const data1 = await decryptData1(notifyJson, sn, promptKey, onStep);
  log.webrtc.info(`${tag()} Decrypted data1 length: ${data1.length}`);

  // Extract public key (strip 10-char padding each end)
  const pubKeyB64 = data1.slice(10, data1.length - 10);
  const publicKey = loadPublicKey(pubKeyB64);

  // Compute path ending from decrypted data1
  const pathEnding = extractPathEnding(data1);
  log.webrtc.info(`${tag()} Path ending: ${pathEnding}`);

  // Step 2: con_ing — encrypted SDP exchange
  const aesKey = generateAesKey();
  log.webrtc.info(`${tag()} AES key: ${aesKey}`);

  const encryptedSdp = await aesEncrypt(JSON.stringify(payload), aesKey);
  const encryptedKey = rsaEncrypt(aesKey, publicKey);

  const body = JSON.stringify({
    data1: encryptedSdp,
    data2: encryptedKey,
  });

  log.webrtc.info(`${tag()} Sending con_ing_${pathEnding} (body: ${body.length} bytes)...`);
  const ingResp = await fetch(proxyUrl(`/con_ing_${pathEnding}`), {
    method: 'POST',
    headers: proxyHeaders(host, 'application/x-www-form-urlencoded'),
    body,
  });

  if (!ingResp.ok) {
    const errText = await ingResp.text();
    throw new Error(`con_ing failed: HTTP ${ingResp.status} — ${errText}`);
  }

  const encryptedAnswer = await ingResp.text();
  log.webrtc.info(`${tag()} con_ing response length: ${encryptedAnswer.length}`);

  const decryptedAnswer = await aesDecrypt(encryptedAnswer, aesKey);
  log.webrtc.info(`${tag()} Decrypted answer: ${decryptedAnswer.slice(0, 100)}...`);

  const answerJson = JSON.parse(decryptedAnswer);
  return answerJson.sdp;
}

async function exchangeSdpOld(ip: string, payload: SdpPayload): Promise<string> {
  const host = `${ip}:${LOCAL_OFFER_PORT}`;

  log.webrtc.info(`${tag()} Sending SDP to ${host}/offer...`);
  const resp = await fetch(proxyUrl('/offer'), {
    method: 'POST',
    headers: proxyHeaders(host, 'application/json'),
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    throw new Error(`offer failed: HTTP ${resp.status}`);
  }

  const answer = await resp.json();
  log.webrtc.info(`${tag()} Received answer from old endpoint`);
  return answer.sdp;
}
