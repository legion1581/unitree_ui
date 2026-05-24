import type { Plugin } from 'vite';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import os from 'node:os';
import { execSync } from 'node:child_process';

// Known Go2 MCU IPs to probe before falling back to gateway detection.
// Go2 EDU: main MCU is always 192.168.123.161 on the internal eth network.
// Go2 standard AP: wlan0 hotspot gateway at 10.42.0.1.
const GO2_CANDIDATE_IPS = ['192.168.123.161', '10.42.0.1', '192.168.12.1'];

function probeHttp(ip: string, port: number, path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: ip, port, path, method: 'POST', timeout: timeoutMs }, (res) => {
      resolve(res.statusCode !== undefined && res.statusCode < 500);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function detectRobotIp(): Promise<string | null> {
  // Probe known Go2 MCU IPs in parallel — return first that responds on port 9991
  const results = await Promise.all(
    GO2_CANDIDATE_IPS.map(async (ip) => ({ ip, ok: await probeHttp(ip, 9991, '/con_notify', 1500) }))
  );
  const hit = results.find((r) => r.ok);
  if (hit) return hit.ip;

  // Fall back to reading the default gateway from ipconfig
  try {
    const out = execSync('ipconfig', { encoding: 'utf8', timeout: 3000 });
    const blocks = out.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      if (!/Wi-Fi|Wireless/i.test(block)) continue;
      const m = block.match(/Default Gateway[^:]*:\s*([\d.]+)/i);
      if (m && m[1] && m[1] !== '0.0.0.0') return m[1];
    }
    const m = out.match(/Default Gateway[^:]*:\s*([\d.]+)/i);
    if (m && m[1] && m[1] !== '0.0.0.0') return m[1];
  } catch { /* ignore */ }
  return null;
}

function getPhysicalIfaces(): string[] {
  const result: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of (list ?? [])) {
      if (!iface.internal && iface.family === 'IPv4') result.push(iface.address);
    }
  }
  return result;
}

// ── UDP Multicast Scanner (embedded) ──
//
// Wire protocol — same on Go2 and G1, only the multicast group(s) differ:
//   * Send query to QUERY_PORT (10131): {"name":"unitree_dapengche"[,"sn":"..."]}
//   * Receive response on RECV_PORT (10134): {sn, ip, ...}
//
// Multicast groups per family:
//   * Go2: 231.1.1.1                       (server/scanner.mjs original)
//   * G1:  231.1.1.2 + 239.255.1.1         (multicast_responder.py on the
//                                          robot at /unitree/.../webrtc_dds_bridge/)
//
// G1 firmware ≥ 1.5.1 added an SN filter to multicast_responder.py: the
// robot drops queries whose `sn` field doesn't match its own. To reach
// those robots, callers must pass `sn` here so it gets embedded in the
// outgoing payload. Queries without `sn` still work on Go2 and G1<1.5.1.

const QUERY_PORT = 10131;
const RECV_PORT = 10134;
const DEFAULT_SCAN_TIMEOUT = 3000;

const FAMILY_GROUPS: Record<string, string[]> = {
  Go2: ['231.1.1.1'],
  G1:  ['231.1.1.2', '239.255.1.1'],
};

function groupsForFamily(family: string): string[] {
  return FAMILY_GROUPS[family] || FAMILY_GROUPS.Go2;
}

// Best-effort family inference from the 16-char SN. Unitree SNs:
//   Go2: starts with B (e.g. B42D2000OBIB1F)
//   G1:  starts with E (e.g. E21D6000PBF9ELG5)
// Returns null when we can't tell — those replies are let through so a new
// SN format doesn't silently break discovery.
function inferFamilyFromSn(sn: string): 'Go2' | 'G1' | null {
  const c = sn?.[0]?.toUpperCase();
  if (c === 'B') return 'Go2';
  if (c === 'E') return 'G1';
  return null;
}

function scanForRobots(family: string, timeoutMs = DEFAULT_SCAN_TIMEOUT, sn?: string): Promise<Array<{ sn: string; ip: string }>> {
  const groups = groupsForFamily(family);
  const queryPayload = sn
    ? JSON.stringify({ name: 'unitree_dapengche', sn })
    : JSON.stringify({ name: 'unitree_dapengche' });
  return new Promise((resolve, reject) => {
    const results: Array<{ sn: string; ip: string }> = [];
    const seen = new Set<string>();

    const receiver = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    receiver.on('error', (err) => {
      receiver.close();
      reject(err);
    });

    receiver.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.sn && data.ip && !seen.has(data.sn)) {
          // SN filter: when targeting a specific robot, drop replies from
          // anyone else (the multicast group can be shared with other
          // robots on the same LAN that respond to broadcast queries).
          if (sn && data.sn !== sn) return;
          // Family filter: port 10134 is shared, so a Go2 announcement can
          // arrive on a G1 scan (and vice versa). Drop replies whose SN
          // prefix doesn't match the requested family.
          const inferred = inferFamilyFromSn(data.sn);
          if (inferred && inferred !== family) {
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
      const ifaces = getPhysicalIfaces();
      for (const g of groups) {
        // Join on every physical interface so Windows picks the right one
        // (without this, the OS may pick the WSL/Hyper-V virtual adapter).
        if (ifaces.length > 0) {
          for (const iface of ifaces) {
            try { receiver.addMembership(g, iface); } catch { /* already member or unsupported */ }
          }
        } else {
          try { receiver.addMembership(g); } catch { /* may already be member */ }
        }
      }

      const buf = Buffer.from(queryPayload);
      // Send from every physical interface so the query reaches the robot
      // regardless of which adapter the OS would otherwise prefer.
      const sendFromIfaces = ifaces.length > 0 ? ifaces : ['0.0.0.0'];
      let sent = 0;
      const sendQuery = (): void => {
        for (const iface of sendFromIfaces) {
          const sender = dgram.createSocket({ type: 'udp4', reuseAddr: true });
          sender.bind(0, iface, () => {
            try { sender.setMulticastInterface(iface); } catch { /* ignore */ }
            for (const g of groups) {
              sender.send(buf, 0, buf.length, QUERY_PORT, g, (err) => {
                if (err) console.warn(`[scanner] Send error to ${g} via ${iface}:`, err.message);
              });
            }
            setTimeout(() => { try { sender.close(); } catch { /* ignore */ } }, 200);
          });
        }
        sent++;
        if (sent < 3) setTimeout(sendQuery, 300);
      };
      sendQuery();
    });

    setTimeout(() => {
      const ifaces = getPhysicalIfaces();
      for (const g of groups) {
        if (ifaces.length > 0) {
          for (const iface of ifaces) {
            try { receiver.dropMembership(g, iface); } catch { /* ignore */ }
          }
        } else {
          try { receiver.dropMembership(g); } catch { /* not a member */ }
        }
      }
      receiver.close();
      resolve(results);
    }, timeoutMs);
  });
}

// ── Vite Plugin ──

export function robotProxyPlugin(): Plugin {
  return {
    name: 'robot-proxy',
    configureServer(server) {
      const defaultPrintUrls = server.printUrls.bind(server);

      server.printUrls = () => {
        const urls = server.resolvedUrls;
        if (!urls) {
          defaultPrintUrls();
          return;
        }

        for (const url of urls.local) {
          server.config.logger.info(`  ->  Local:   ${url}`);
        }
        for (const url of urls.network) {
          server.config.logger.info(`  ->  Network: ${url}`);
        }
        if (urls.network.length === 0) {
          server.config.logger.info('  ->  Network: run `npm run dev:host` to expose on your LAN');
        }
      };

      // Handle /scan requests directly (no separate scanner process needed)
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost');

        if (url.pathname === '/scan' && req.method === 'GET') {
          const timeout = parseInt(url.searchParams.get('timeout') || String(DEFAULT_SCAN_TIMEOUT), 10);
          const family = url.searchParams.get('family') || 'Go2';
          const sn = url.searchParams.get('sn') || undefined;
          console.log(`[scanner] Scan requested (family=${family}, timeout=${timeout}ms${sn ? `, sn=${sn}` : ''})`);

          scanForRobots(family, timeout, sn)
            .then((robots) => {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ robots }));
            })
            .catch((err) => {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: (err as Error).message }));
            });
          return;
        }

        if (url.pathname === '/gateway' && req.method === 'GET') {
          detectRobotIp().then((gateway) => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ gateway }));
          }).catch(() => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ gateway: null }));
          });
          return;
        }

        // Proxy BLE server API (Python FastAPI on port 5051)
        if (url.pathname.startsWith('/ble-api/')) {
          const targetPath = req.url!.replace('/ble-api', '');
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            const body = Buffer.concat(chunks);
            const headers: Record<string, string> = {};
            for (const [key, val] of Object.entries(req.headers)) {
              if (typeof val === 'string' && key !== 'host' && key !== 'origin' && key !== 'referer') {
                headers[key] = val;
              }
            }
            if (body.length > 0) {
              headers['content-length'] = body.length.toString();
            }

            const proxyReq = http.request(
              { hostname: '127.0.0.1', port: 5051, path: targetPath, method: req.method, headers },
              (proxyRes) => {
                res.statusCode = proxyRes.statusCode ?? 500;
                if (proxyRes.headers['content-type']) res.setHeader('Content-Type', proxyRes.headers['content-type']);
                proxyRes.pipe(res);
              },
            );
            proxyReq.on('error', (err) => {
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `BLE server not running: ${err.message}. Start with: python3 server/ble_server.py` }));
            });
            if (body.length > 0) proxyReq.end(body);
            else proxyReq.end();
          });
          return;
        }

        // Proxy Unitree cloud API requests to avoid CORS
        if (url.pathname.startsWith('/unitree-api/')) {
          const targetPath = req.url!.replace('/unitree-api', '');
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            const body = Buffer.concat(chunks);
            const headers: Record<string, string> = {};
            // Forward all custom headers
            for (const [key, val] of Object.entries(req.headers)) {
              if (typeof val === 'string' && key !== 'host' && key !== 'origin' && key !== 'referer') {
                headers[key] = val;
              }
            }
            if (body.length > 0) {
              headers['content-length'] = body.length.toString();
            }

            // Region selector: client sends `X-Unitree-Region: cn` to hit the
            // mainland-China endpoint, anything else (or absent) defaults to
            // the global endpoint. The header is consumed by the proxy and
            // stripped before forwarding upstream.
            const region = (headers['x-unitree-region'] || '').toLowerCase();
            const hostname = region === 'cn'
              ? 'robot-api.unitree.com'
              : 'global-robot-api.unitree.com';
            delete headers['x-unitree-region'];

            // Set User-Agent to match Android app (EdgeOne WAF blocks Node defaults)
            headers['user-agent'] = 'okhttp/4.11.0';
            // Ask for identity encoding — we don't want the server to gzip/deflate
            // the body. Some endpoints return raw compressed bytes without sending
            // the proper Content-Encoding header, which makes the browser parse
            // them as binary JSON. Forcing identity avoids the ambiguity.
            headers['accept-encoding'] = 'identity';
            // Remove headers that leak browser/proxy origin or bloat the request
            delete headers['sec-fetch-site'];
            delete headers['sec-fetch-mode'];
            delete headers['sec-fetch-dest'];
            delete headers['sec-ch-ua'];
            delete headers['sec-ch-ua-mobile'];
            delete headers['sec-ch-ua-platform'];
            // Never forward browser cookies — they are unrelated to the upstream
            // API (which uses the Token header for auth) and can cause nginx to
            // reject the request with "400 Request Header Or Cookie Too Large".
            delete headers['cookie'];

            const proxyReq = https.request(
              {
                hostname,
                port: 443,
                path: targetPath,
                method: req.method,
                headers,
              },
              (proxyRes) => {
                res.statusCode = proxyRes.statusCode ?? 500;
                // Forward ALL response headers (previously only content-type was
                // forwarded, which dropped Content-Encoding — causing the browser
                // to see compressed bytes without knowing to decompress them)
                for (const [key, val] of Object.entries(proxyRes.headers)) {
                  if (val === undefined) continue;
                  // Skip hop-by-hop headers that shouldn't be forwarded
                  const k = key.toLowerCase();
                  if (k === 'transfer-encoding' || k === 'connection') continue;
                  res.setHeader(key, val as string | string[]);
                }
                proxyRes.pipe(res);
              },
            );

            proxyReq.on('error', (err) => {
              res.statusCode = 502;
              res.end(`Proxy error: ${err.message}`);
            });

            if (body.length > 0) {
              proxyReq.end(body);
            } else {
              proxyReq.end();
            }
          });
          return;
        }

        if (!req.url?.startsWith('/robot-api/')) {
          return next();
        }

        const targetHost = req.headers['x-robot-host'] as string;
        if (!targetHost) {
          res.statusCode = 400;
          res.end('Missing X-Robot-Host header');
          return;
        }

        const path = req.url.replace('/robot-api', '');
        const [host, portStr] = targetHost.split(':');
        const port = parseInt(portStr, 10);

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const body = Buffer.concat(chunks);

          const headers: Record<string, string> = {};
          if (body.length > 0) {
            headers['Content-Type'] = req.headers['content-type'] || 'application/json';
            headers['Content-Length'] = body.length.toString();
          }

          const proxyReq = http.request(
            { hostname: host, port, path, method: req.method, headers },
            (proxyRes) => {
              res.statusCode = proxyRes.statusCode ?? 500;
              if (proxyRes.headers['content-type']) {
                res.setHeader('Content-Type', proxyRes.headers['content-type']);
              }
              proxyRes.pipe(res);
            },
          );

          proxyReq.on('error', (err) => {
            res.statusCode = 502;
            res.end(`Proxy error: ${err.message}`);
          });

          if (body.length > 0) {
            proxyReq.end(body);
          } else {
            proxyReq.end();
          }
        });
      });
    },
  };
}
