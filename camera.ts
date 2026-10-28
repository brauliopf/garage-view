const fs = require('node:fs');
const dgram = require('node:dgram');
const net = require('node:net');
const path = require('node:path');
const P = require('./protocol');

function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*["']?([^"']*)["']?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}
function readConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file));
  } catch {
    return null;
  }
}
function discover(ip, wait = 3) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4'),
      found = new Map(),
      end = Date.now() + wait * 1000;
    socket.on('message', (data, rinfo) => {
      const dev = P.parseDiscovery(data, rinfo.address);
      if (dev?.did) found.set(dev.did, dev);
    });
    socket.once('error', reject);
    socket.bind(0, () => {
      socket.setBroadcast(true);
      const destinations = [[P.PORT, '255.255.255.255'] as const];
      if (ip) destinations.push([P.PORT, ip] as const);
      for (const [port, address] of destinations) socket.send(P.discoveryPing(), port, address);
    });
    const timer = setInterval(() => {
      if (Date.now() >= end) {
        clearInterval(timer);
        socket.close();
        resolve([...found.values()]);
      }
    }, 100);
  });
}
async function resolveCamera(options) {
  loadEnv();
  const requested = {
    ip: options.ip && options.ip !== 'auto' ? options.ip : process.env.A9_CAMERA_IP,
    did: options.did || process.env.A9_CAMERA_DID,
    secret: options.secret || process.env.A9_CAMERA_SECRET,
  };
  if (requested.ip && requested.did && requested.secret) return requested;
  let config = options.noConfig ? null : readConfig(options.config);
  if (
    config &&
    ((requested.ip && config.ip !== requested.ip) ||
      (requested.did && config.did !== requested.did))
  )
    config = null;
  if (config && config.ip && config.did && config.secret) return { ...config, ...requested };
  const devices = await discover(requested.ip, options.discWait);
  const matching = devices.filter((d) => !options.did || d.did === options.did);
  if (!matching.length) throw new Error('no matching camera answered discovery');
  if (matching.length > 1)
    throw new Error(
      `multiple cameras answered; use --did (${matching.map((d) => d.did).join(', ')})`,
    );
  const d = matching[0];
  return { ...d, did: options.did || d.did, secret: options.secret || d.secret, ip: d.ip };
}
class Camera {
  constructor(info, state, options) {
    this.info = info;
    this.state = state;
    this.options = options;
    this.stop = false;
    this.seq = options.startSeq;
    this.timer = null;
  }
  start() {
    this.run();
  }
  async run() {
    while (!this.stop) {
      try {
        await this.session();
      } catch (e) {
        if (!this.stop) console.error(`[camera] ${e.message}; reconnecting in 2s`);
      }
      if (!this.stop) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  session() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.info.ip, port: P.PORT });
      let buffer = Buffer.alloc(0),
        sessionKey = null,
        fragments = [],
        fragmentBytes = 0,
        started = false,
        frames = 0,
        lastMedia = Date.now(),
        lastPing = 0,
        closed = false;
      const fail = (e) => {
        if (closed) return;
        closed = true;
        this.state.connected = false;
        socket.destroy();
        reject(e);
      };
      const send = (cmd, body = Buffer.alloc(0), flag = 0x0c) =>
        socket.write(P.buildCtrl(this.seq++, cmd, body, flag));
      const process = (packet) => {
        if (packet.type === 4) {
          const h = P.ctrlHeader(packet.body);
          if (h.cmd === P.CMD.LANAUTH && !sessionKey) {
            const p = P.ctrlDecrypt(h.cmd, h.seq, h.rpc, h.encrypted);
            sessionKey = p && P.pbParse(p).get(1)?.[0];
            if (!sessionKey) return fail(new Error('authentication returned no session key'));
            send(P.CMD.HELLO, P.pbInt(1, 1));
            setTimeout(() => {
              send(2653);
              send(2645);
              send(P.CMD.VIDEOPLAY);
              this.state.connected = true;
            }, 300);
          } else if (h.rpc === 0 && h.cmd === P.CMD.PING) {
            const p = P.ctrlDecrypt(h.cmd, h.seq, h.rpc, h.encrypted),
              echo = p ? Number(P.pbParse(p).get(1)?.[0] ?? 0) : 0;
            socket.write(
              P.buildCtrl(
                h.seq,
                P.CMD.PING,
                Buffer.concat([
                  P.pbInt(1, echo),
                  P.pbInt(2, P.HB_CONST),
                  P.pbInt(3, BigInt(Date.now())),
                ]),
                0x0d,
              ),
            );
          } else if (h.cmd === P.CMD.STATUS && h.encrypted.length % 16 === 0) {
            const p = P.ctrlDecrypt(h.cmd, h.seq, h.rpc, h.encrypted);
            if (p) this.state.status = P.status(p);
          }
        }
        if (packet.type === 6) {
          lastMedia = Date.now();
          if (packet.body[0] >> 7) {
            if (started) {
              const jpg = P.decryptMedia(fragments, sessionKey);
              if (jpg) this.state.publish(jpg);
            }
            fragments = [packet.body];
            fragmentBytes = packet.body.length;
            started = true;
            frames++;
          } else if (
            started &&
            fragmentBytes + packet.body.length <= 8 * 1024 * 1024 &&
            fragments.length < 4096
          ) {
            fragments.push(packet.body);
            fragmentBytes += packet.body.length;
          }
        }
      };
      socket.setTimeout(this.options.timeout * 1000, () =>
        fail(new Error('camera connection timeout')),
      );
      socket.on('connect', () => {
        send(
          P.CMD.LANAUTH,
          Buffer.concat([
            P.pbBytes(2, Buffer.from(this.info.did)),
            P.pbBytes(3, Buffer.from(this.info.secret)),
          ]),
        );
      });
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const parsed = P.frames(buffer);
        buffer = parsed[1];
        for (const packet of parsed[0]) process(packet);
        if (Date.now() - lastPing > 500 && sessionKey) {
          send(
            P.CMD.PING,
            Buffer.concat([P.pbInt(1, BigInt(Date.now())), P.pbInt(4, BigInt(frames))]),
          );
          lastPing = Date.now();
        }
        if (Date.now() - lastMedia > 6000 && sessionKey) fail(new Error('media stalled'));
      });
      socket.on('error', fail);
      socket.on('close', () => {
        if (!closed) fail(new Error('camera closed connection'));
      });
      this.timer = setInterval(() => {
        if (sessionKey && Date.now() - lastMedia > 6000) fail(new Error('media stalled'));
      }, 500);
      socket.on('close', () => clearInterval(this.timer));
    });
  }
  close() {
    this.stop = true;
    if (this.timer) clearInterval(this.timer);
  }
}
module.exports = { resolveCamera, Camera, loadEnv };
