'use strict';

const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_FILE_MB = 40;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const MAX_TRACKS = 30;
const MAX_MEMBERS = 12;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.webm']);
const CODE_RE = /^[A-Z0-9]{4,8}$/;

// Rooms live in memory, so uploads from a previous run are orphaned. Start clean.
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
for (const entry of fs.readdirSync(UPLOAD_DIR)) {
  fs.rmSync(path.join(UPLOAD_DIR, entry), { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* Room state                                                          */
/* ------------------------------------------------------------------ */

// A room stores one shared timeline: where the song was (position, in seconds)
// at a server-clock moment (anchor, in ms). Every device derives "what should
// I be hearing right now" from those two numbers plus its own clock offset.
const rooms = new Map();

function createRoom(code) {
  const room = {
    code,
    tracks: [],
    index: -1,
    playing: false,
    position: 0,
    anchor: Date.now(),
    clients: new Map(),
    cleanupTimer: null,
  };
  rooms.set(code, room);
  fs.mkdirSync(path.join(UPLOAD_DIR, code), { recursive: true });
  return room;
}

function destroyRoom(room) {
  clearTimeout(room.cleanupTimer);
  rooms.delete(room.code);
  fs.rm(path.join(UPLOAD_DIR, room.code), { recursive: true, force: true }, () => {});
}

function scheduleCleanup(room) {
  clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    if (room.clients.size === 0) destroyRoom(room);
  }, EMPTY_ROOM_TTL_MS);
}

function positionNow(room, now = Date.now()) {
  return room.playing ? room.position + (now - room.anchor) / 1000 : room.position;
}

function snapshot(room) {
  const now = Date.now();
  return {
    type: 'state',
    serverNow: now,
    tracks: room.tracks.map(({ id, title, url, by }) => ({ id, title, url, by })),
    index: room.index,
    playing: room.playing,
    position: positionNow(room, now),
    members: [...room.clients.values()].map((c) => ({ id: c.id, name: c.name })),
  };
}

function broadcast(room) {
  const msg = JSON.stringify(snapshot(room));
  for (const client of room.clients.values()) {
    if (client.ws.readyState === 1) client.ws.send(msg);
  }
}

function setTrack(room, index) {
  room.index = index;
  room.position = 0;
  room.anchor = Date.now();
}

function stopPlayback(room) {
  room.playing = false;
  room.position = 0;
  room.anchor = Date.now();
}

function deleteTrackFile(room, track) {
  fs.rm(path.join(UPLOAD_DIR, room.code, track.file), { force: true }, () => {});
}

// Each action returns true when the room changed and should be re-broadcast.
const actions = {
  play(room) {
    if (!room.tracks.length) return false;
    if (room.index < 0) setTrack(room, 0);
    if (!room.playing) {
      room.playing = true;
      room.anchor = Date.now();
    }
    return true;
  },

  pause(room) {
    if (room.playing) {
      room.position = positionNow(room);
      room.playing = false;
    }
    return true;
  },

  seek(room, msg) {
    const position = Number(msg.position);
    if (!Number.isFinite(position) || position < 0 || room.index < 0) return false;
    room.position = position;
    room.anchor = Date.now();
    return true;
  },

  select(room, msg) {
    const index = Number(msg.index);
    if (!Number.isInteger(index) || index < 0 || index >= room.tracks.length) return false;
    setTrack(room, index);
    room.playing = true;
    return true;
  },

  next(room) {
    if (room.index + 1 >= room.tracks.length) return false;
    setTrack(room, room.index + 1);
    room.playing = true;
    return true;
  },

  prev(room) {
    if (room.index < 0) return false;
    if (room.index === 0 || positionNow(room) > 3) {
      room.position = 0;
      room.anchor = Date.now();
    } else {
      setTrack(room, room.index - 1);
    }
    return true;
  },

  // Every device reports when a song finishes. The first report wins; the
  // rest name a track that is no longer current and are ignored.
  ended(room, msg) {
    const current = room.tracks[room.index];
    if (!current || current.id !== msg.id) return false;
    if (room.index + 1 < room.tracks.length) {
      setTrack(room, room.index + 1);
    } else {
      stopPlayback(room);
    }
    return true;
  },

  remove(room, msg) {
    const i = room.tracks.findIndex((t) => t.id === msg.id);
    if (i < 0) return false;
    const [removed] = room.tracks.splice(i, 1);
    deleteTrackFile(room, removed);

    if (room.tracks.length === 0) {
      room.index = -1;
      stopPlayback(room);
    } else if (i < room.index) {
      room.index -= 1;
    } else if (i === room.index) {
      if (i >= room.tracks.length) {
        room.index = room.tracks.length - 1;
        stopPlayback(room);
      } else {
        setTrack(room, i);
      }
    }
    return true;
  },
};

/* ------------------------------------------------------------------ */
/* HTTP: static files, media, uploads                                  */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');

app.use(express.static(path.join(__dirname, 'public')));

app.use(
  '/media',
  express.static(UPLOAD_DIR, {
    index: false,
    dotfiles: 'deny',
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=3600');
    },
  })
);

function cleanName(raw, fallback = 'Guest') {
  const name = String(raw || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 24);
  return name || fallback;
}

function requireRoom(req, res, next) {
  const code = String(req.params.code || '').toUpperCase();
  const room = CODE_RE.test(code) ? rooms.get(code) : null;
  if (!room) return res.status(404).json({ error: 'That room no longer exists.' });
  req.params.code = code;
  req.room = room;
  next();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(UPLOAD_DIR, req.params.code)),
  filename: (req, file, cb) =>
    cb(null, crypto.randomBytes(8).toString('hex') + path.extname(file.originalname).toLowerCase()),
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 10 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (AUDIO_EXT.has(ext)) return cb(null, true);
    cb(new Error('NOT_AUDIO'));
  },
});

app.post(
  '/api/rooms/:code/tracks',
  requireRoom,
  (req, res, next) => {
    if (req.room.tracks.length >= MAX_TRACKS) {
      return res.status(409).json({ error: `A room holds up to ${MAX_TRACKS} songs. Remove one to add more.` });
    }
    next();
  },
  upload.array('files', 10),
  (req, res) => {
    const room = req.room;
    const by = cleanName(req.query.by);
    const slots = MAX_TRACKS - room.tracks.length;
    const files = req.files || [];
    let added = 0;

    files.forEach((file, i) => {
      if (i >= slots) {
        fs.rm(file.path, { force: true }, () => {});
        return;
      }
      const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const title = path.basename(original, path.extname(original)).trim().slice(0, 80) || 'Untitled';
      room.tracks.push({
        id: crypto.randomBytes(6).toString('hex'),
        title,
        by,
        file: file.filename,
        url: `/media/${room.code}/${file.filename}`,
      });
      added += 1;
    });

    if (room.index < 0 && room.tracks.length) setTrack(room, 0);
    if (added) broadcast(room);
    res.json({ added });
  }
);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Each file must be ${MAX_FILE_MB} MB or smaller.` });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: 'Upload up to 10 files at a time.' });
  }
  if (err && err.message === 'NOT_AUDIO') {
    return res.status(415).json({ error: 'Only audio files work here: MP3, M4A, WAV, OGG, FLAC or OPUS.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Upload failed. Try again.' });
});

/* ------------------------------------------------------------------ */
/* WebSocket: rooms, clock pings, playback commands                    */
/* ------------------------------------------------------------------ */

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const code = String(params.get('room') || '').toUpperCase();
  const create = params.get('create') === '1';

  if (!CODE_RE.test(code)) return ws.close(4000, 'bad room code');

  let room = rooms.get(code);
  if (!room) {
    if (!create) return ws.close(4004, 'room not found');
    room = createRoom(code);
  }
  if (room.clients.size >= MAX_MEMBERS) return ws.close(4003, 'room full');

  clearTimeout(room.cleanupTimer);

  const client = {
    id: crypto.randomBytes(4).toString('hex'),
    name: cleanName(params.get('name')),
    ws,
    windowStart: Date.now(),
    windowCount: 0,
  };
  room.clients.set(client.id, client);

  ws.send(JSON.stringify({ type: 'hello', id: client.id, code: room.code }));
  broadcast(room);

  ws.isDead = false;
  ws.on('pong', () => {
    ws.isDead = false;
  });

  ws.on('message', (data) => {
    // Simple flood guard: at most 40 messages per second per device.
    const now = Date.now();
    if (now - client.windowStart > 1000) {
      client.windowStart = now;
      client.windowCount = 0;
    }
    if (++client.windowCount > 40) return;

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t0: msg.t0, serverNow: Date.now() }));
      return;
    }

    if (Object.prototype.hasOwnProperty.call(actions, msg.type)) {
      if (actions[msg.type](room, msg)) broadcast(room);
    }
  });

  ws.on('close', () => {
    room.clients.delete(client.id);
    if (room.clients.size === 0) {
      scheduleCleanup(room);
    } else {
      broadcast(room);
    }
  });
});

// Drop devices that stopped answering (closed laptop lid, lost Wi-Fi).
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isDead) {
      ws.terminate();
      continue;
    }
    ws.isDead = true;
    ws.ping();
  }
}, 30000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nUnison is running.\n`);
  console.log(`  This computer:  http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`  Other devices:  http://${a.address}:${PORT}   (same Wi-Fi)`);
      }
    }
  }
  console.log('');
});
