/**
 * UDP Multicast Scanner for Unitree robots (Go2 + G1).
 *
 * Wire protocol — same on both, only the multicast group(s) differ:
 *   - Send query to port 10131: {"name":"unitree_dapengche"[,"sn":"..."]}
 *   - Receive responses on port 10134: {"sn":"<serial>","ip":"<ip>"}
 *
 * Multicast groups per family:
 *   - Go2: 231.1.1.1
 *   - G1:  231.1.1.2 + 239.255.1.1   (matches multicast_responder.py on
 *          /unitree/.../webrtc_dds_bridge/ in G1 firmware 1.5.1)
 *
 * G1 firmware ≥ 1.5.1 added an SN filter: the robot drops queries whose
 * `sn` field doesn't match its own. Pass `sn` here to embed it.
 *
 * Exposes a tiny HTTP API on port 3001:
 *   GET /scan?family=Go2|G1     → scans and returns JSON array of found robots
 *   GET /scan?sn=B42D...        → SN-targeted scan (required for G1 ≥ 1.5.1)
 *   GET /scan?timeout=5000      → custom timeout in ms (default 3000)
 */

import dgram from 'node:dgram';
import http from 'node:http';

const FAMILY_GROUPS = {
  Go2: ['231.1.1.1'],
  G1:  ['231.1.1.2', '239.255.1.1'],
  // R1 is an Explorer-line humanoid; same multicast groups as G1.
  R1:  ['231.1.1.2', '239.255.1.1'],
};
const QUERY_PORT = 10131;
const RECV_PORT = 10134;
const DEFAULT_TIMEOUT = 3000;
const HTTP_PORT = parseInt(process.env.SCANNER_PORT || '3001', 10);

/** Discovery bucket: the Explorer humanoids (G1 / R1) share one multicast
 *  group set, Go2 has its own. Used so a genuinely cross-class reply is
 *  dropped while an R1 robot still shows up on a G1 scan (and vice versa). */
function familyBucket(family) {
  return family === 'Go2' ? 'go2' : 'explorer';
}

/** Best-effort family inference from the 16-char SN. Unitree SNs:
 *    Go2: starts with B (e.g. B42D2000OBIB1F)
 *    G1:  starts with E (e.g. E21D6000PBF9ELG5)
 *  Returns null when we can't tell — those replies are let through. */
function inferFamilyFromSn(sn) {
  const c = sn?.[0]?.toUpperCase();
  if (c === 'B') return 'Go2';
  if (c === 'E') return 'G1';
  return null;
}

/**
 * Perform a UDP multicast scan for a family of robots.
 * @param {'Go2' | 'G1'} family  Which multicast group set to use.
 * @param {number} timeoutMs     How long to listen for responses.
 * @param {string=} sn           Optional serial number to target (G1 ≥ 1.5.1).
 * @returns {Promise<Array<{sn: string, ip: string}>>}
 */
function scanForRobots(family = 'Go2', timeoutMs = DEFAULT_TIMEOUT, sn) {
  const groups = FAMILY_GROUPS[family] || FAMILY_GROUPS.Go2;
  const queryPayload = sn
    ? JSON.stringify({ name: 'unitree_dapengche', sn })
    : JSON.stringify({ name: 'unitree_dapengche' });
  return new Promise((resolve, reject) => {
    const results = [];
    const seen = new Set();

    const receiver = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    receiver.on('error', (err) => {
      receiver.close();
      reject(err);
    });

    receiver.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.sn && data.ip && !seen.has(data.sn)) {
          if (sn && data.sn !== sn) return;
          // Family filter: port 10134 is shared, so a Go2 announcement can
          // arrive on an Explorer scan (and vice versa). Drop replies from
          // the other chassis bucket only — G1 and R1 share a bucket, so an
          // R1 robot isn't dropped from a G1 scan.
          const inferred = inferFamilyFromSn(data.sn);
          if (inferred && familyBucket(inferred) !== familyBucket(family)) {
            console.log(`[scanner] Dropping cross-family reply: requested=${family} sn=${data.sn} (looks like ${inferred})`);
            return;
          }
          seen.add(data.sn);
          results.push({ sn: data.sn, ip: data.ip });
          console.log(`[scanner] Found ${family} robot: SN=${data.sn} IP=${data.ip}`);
        }
      } catch { /* ignore non-JSON */ }
    });

    receiver.bind(RECV_PORT, () => {
      for (const g of groups) {
        try { receiver.addMembership(g); } catch { /* may already be member */ }
      }

      const sender = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const buf = Buffer.from(queryPayload);
      let sent = 0;
      const sendQuery = () => {
        for (const g of groups) {
          sender.send(buf, 0, buf.length, QUERY_PORT, g, (err) => {
            if (err) console.warn(`[scanner] Send error to ${g}:`, err.message);
          });
        }
        sent++;
        if (sent < 3) setTimeout(sendQuery, 200);
        else setTimeout(() => sender.close(), 100);
      };
      sendQuery();
    });

    setTimeout(() => {
      for (const g of groups) {
        try { receiver.dropMembership(g); } catch { /* not a member */ }
      }
      receiver.close();
      resolve(results);
    }, timeoutMs);
  });
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${HTTP_PORT}`);

  if (url.pathname === '/scan' && req.method === 'GET') {
    const timeout = parseInt(url.searchParams.get('timeout') || String(DEFAULT_TIMEOUT), 10);
    const family = url.searchParams.get('family') || 'Go2';
    const sn = url.searchParams.get('sn') || undefined;
    console.log(`[scanner] Scan requested (family=${family}, timeout=${timeout}ms${sn ? `, sn=${sn}` : ''})`);

    try {
      const robots = await scanForRobots(family, timeout, sn);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ robots }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(HTTP_PORT, () => {
  console.log(`[scanner] UDP multicast scanner listening on http://localhost:${HTTP_PORT}`);
  console.log(`[scanner] GET /scan to discover Go2 robots on the network`);
});
