#!/usr/bin/env node
const http = require('node:http');
const path = require('node:path');
const { resolveCamera, Camera, loadEnv } = require('./camera');

class State {
  constructor() {
    this.jpeg = null;
    this.sequence = 0;
    this.receivedAt = 0;
    this.connected = false;
    this.status = null;
    this.listeners = new Set();
  }
  publish(jpeg) {
    this.jpeg = jpeg;
    this.sequence++;
    this.receivedAt = Date.now();
    for (const fn of this.listeners) fn();
  }
  wait(after, timeout) {
    return new Promise((resolve) => {
      if (this.sequence > after) return resolve([this.jpeg, this.sequence]);
      const fn = () => {
        clearTimeout(timer);
        this.listeners.delete(fn);
        resolve([this.jpeg, this.sequence]);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(fn);
        resolve([null, after]);
      }, timeout);
      this.listeners.add(fn);
    });
  }
}
function args(argv) {
  const out = {
    config: path.join(__dirname, 'a9_camera.json'),
    bind: '127.0.0.1',
    port: 8080,
    timeout: 8,
    maxAge: 10,
    discWait: 3,
    startSeq: 3,
  };
  const names = {
    '--config': 'config',
    '--bind': 'bind',
    '--http-port': 'port',
    '--timeout': 'timeout',
    '--max-age': 'maxAge',
    '--disc-wait': 'discWait',
    '--start-seq': 'startSeq',
    '--did': 'did',
    '--secret': 'secret',
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--no-config') out.noConfig = true;
    else if (x === '--help') {
      console.log(
        'npm start -- [camera-ip|auto] [--did DID] [--secret SECRET] [--bind HOST] [--http-port PORT]',
      );
      process.exit();
    } else if (names[x]) out[names[x]] = argv[++i];
    else if (x.startsWith('--')) throw new Error(`unknown option ${x}`);
    else positional.push(x);
  }
  out.ip = positional[0];
  for (const k of ['port', 'timeout', 'maxAge', 'discWait', 'startSeq']) out[k] = Number(out[k]);
  if (!Number.isFinite(out.port) || out.port < 1 || out.port > 65535)
    throw new Error('invalid --http-port');
  return out;
}
function handler(state, options) {
  return async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/' || pathname === '/index.html') {
      const body = Buffer.from(
        "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>A9 live</title><body style='margin:0;background:#111'><img src='/stream.mjpg' style='width:100%;height:auto;display:block'></body>",
      );
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': body.length });
      return res.end(body);
    }
    if (pathname.startsWith('/status')) {
      const age = state.receivedAt ? (Date.now() - state.receivedAt) / 1000 : null;
      const body = Buffer.from(
        JSON.stringify({
          ...(state.status || {}),
          connected: state.connected,
          streaming: age !== null && age < 3,
          last_frame_age_s: age === null ? null : Math.round(age * 10) / 10,
        }),
      );
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Content-Length': body.length,
      });
      return res.end(body);
    }
    if (pathname.startsWith('/snapshot')) {
      const [jpeg] = await state.wait(0, (options.timeout + 4) * 1000);
      const age = state.receivedAt ? (Date.now() - state.receivedAt) / 1000 : Infinity;
      if (!jpeg || age > options.maxAge) return res.writeHead(503).end('no fresh frame');
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-store',
        'Content-Length': jpeg.length,
      });
      return res.end(jpeg);
    }
    if (pathname.startsWith('/stream')) {
      const admission = state.sequence;
      const [first] = await state.wait(admission, (options.timeout + 4) * 1000);
      if (!first) return res.writeHead(503).end('no fresh frame');
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-store',
      });
      let sequence = admission;
      try {
        while (!state.stop) {
          const [jpeg, next] = await state.wait(sequence, 5000);
          if (!jpeg) continue;
          sequence = next;
          const head = Buffer.from(
            `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
          );
          res.write(Buffer.concat([head, jpeg, Buffer.from('\r\n')])) ||
            (() => {
              throw new Error('slow client');
            })();
        }
      } catch {}
      return;
    }
    res.writeHead(404).end();
  };
}
async function main() {
  loadEnv();
  const options = args(process.argv.slice(2));
  const info = await resolveCamera(options);
  console.error(`[camera] ${info.did} @ ${info.ip}`);
  const state = new State();
  const camera = new Camera(info, state, options);
  state.publish = state.publish.bind(state);
  camera.start();
  const server = http.createServer(handler(state, options));
  server.on('error', (error: any) => {
    camera.close();
    console.error(`[!] could not serve http://${options.bind}:${options.port}: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(options.port, options.bind, () =>
    console.error(`[*] serving http://${options.bind}:${options.port}/`),
  );
  const shutdown = () => {
    state.stop = true;
    camera.close();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
main().catch((e) => {
  console.error(`[!] ${e.message}`);
  process.exitCode = 1;
});
