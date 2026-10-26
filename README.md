# Garage camera

Minimal TypeScript/Node.js client and HTTP MJPEG server for the local A9 camera.

## Run

```bash
npm install
npm start
```

Open `http://127.0.0.1:8080/`. To access it from another device on the LAN:

```bash
npm start -- --bind 0.0.0.0 --http-port 8081
```

Copy `.env.example` to `.env`; `.env` is ignored by Git and is the place for
all local secrets and camera identity values:

```bash
cp .env.example .env
```

```dotenv
A9_PREKEY=...
A9_CAMERA_IP=192.0.2.10
A9_CAMERA_DID=...
A9_CAMERA_SECRET=...

```

The HTTP feed is intentionally unauthenticated for this local camera setup. Keep
it on a trusted LAN or private VPN; do not expose it directly to the public internet.

If the camera identity values are omitted, the service discovers a camera on the LAN.
`a9_camera.json` remains supported for compatibility but is ignored and should not be committed.

## Tests

```bash
npm test
```

Routes: `/`, `/stream.mjpg`, `/snapshot.jpg`, and `/status`.
