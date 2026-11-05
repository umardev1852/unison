(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const el = {
    lobby: $('#lobby'),
    room: $('#room'),
    joinForm: $('#joinForm'),
    nameInput: $('#nameInput'),
    codeInput: $('#codeInput'),
    createBtn: $('#createBtn'),
    lobbyError: $('#lobbyError'),
    roomCode: $('#roomCode'),
    copyBtn: $('#copyBtn'),
    leaveBtn: $('#leaveBtn'),
    soundGate: $('#soundGate'),
    soundBtn: $('#soundBtn'),
    ring: $('#ring'),
    nowTitle: $('#nowTitle'),
    nowBy: $('#nowBy'),
    members: $('#members'),
    prevBtn: $('#prevBtn'),
    playBtn: $('#playBtn'),
    nextBtn: $('#nextBtn'),
    playIcon: $('#playIcon'),
    pauseIcon: $('#pauseIcon'),
    seek: $('#seek'),
    timeNow: $('#timeNow'),
    timeTotal: $('#timeTotal'),
    volume: $('#volume'),
    syncStatus: $('#syncStatus'),
    addBtn: $('#addBtn'),
    fileInput: $('#fileInput'),
    dropzone: $('#dropzone'),
    queueList: $('#queueList'),
    queueEmpty: $('#queueEmpty'),
    uploadStatus: $('#uploadStatus'),
    toast: $('#toast'),
  };

  const MAX_FILE_MB = 40;
  const AUDIO_NAME_RE = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;
  const SWEEP_SECONDS = 4; // one lap of the ring per 4 seconds of song time
  const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

  const audio = new Audio();
  audio.preload = 'auto';
  audio.playsInline = true;

  let ws = null;
  let roomCode = '';
  let myName = '';
  let myId = '';
  let inRoom = false;
  let leaving = false;
  let reconnectTimer = null;
  let reconnectDelay = 1000;

  let state = null;       // latest room snapshot from the server
  let loadedTrackId = null;
  let seeking = false;

  // Clock sync: offset = (server clock) - (this device's clock), in ms.
  let clockOffset = 0;
  let clockSamples = [];
  let latencyMs = null;
  let pingTimer = null;

  /* ---------------- helpers ---------------- */

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch {
      return null;
    }
    return null;
  }

  const NAME_A = ['Amber', 'Cobalt', 'Juniper', 'Sable', 'Marigold', 'Slate', 'Coral', 'Indigo', 'Fern', 'Quartz'];
  const NAME_B = ['Fox', 'Heron', 'Otter', 'Lynx', 'Finch', 'Seal', 'Wren', 'Moth', 'Crane', 'Hare'];
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const randomName = () => `${pick(NAME_A)} ${pick(NAME_B)}`;

  function randomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  const cleanCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  let toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 4500);
  }

  function showLobbyError(message) {
    el.lobbyError.textContent = message;
    el.lobbyError.hidden = !message;
  }

  const serverNow = () => Date.now() + clockOffset;

  /* ---------------- clock sync ---------------- */

  function sendPing() {
    send({ type: 'ping', t0: Date.now() });
  }

  function startClockSync() {
    clockSamples = [];
    let burst = 0;
    const fire = () => {
      sendPing();
      if (++burst < 8) setTimeout(fire, 120);
    };
    fire();
    clearInterval(pingTimer);
    pingTimer = setInterval(sendPing, 8000);
  }

  function onPong(msg) {
    const t1 = Date.now();
    const rtt = t1 - msg.t0;
    if (rtt < 0 || rtt > 5000) return;
    // Assume the reply took half the round trip to get back.
    const offset = msg.serverNow + rtt / 2 - t1;
    clockSamples.push({ rtt, offset });
    if (clockSamples.length > 12) clockSamples.shift();
    // The fastest round trip is the least distorted by queueing delays.
    const best = clockSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    clockOffset = best.offset;
    latencyMs = best.rtt;
  }

  /* ---------------- websocket ---------------- */

  function send(message) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
  }

  function connect(create) {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${scheme}://${location.host}/ws?room=${encodeURIComponent(roomCode)}&name=${encodeURIComponent(myName)}${create ? '&create=1' : ''}`;
    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = () => {
      reconnectDelay = 1000;
      startClockSync();
    };

    socket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'hello') myId = msg.id;
      else if (msg.type === 'pong') onPong(msg);
      else if (msg.type === 'state') onState(msg);
    };

    socket.onclose = (event) => {
      if (socket !== ws) return;
      clearInterval(pingTimer);
      if (leaving) return;

      if (!inRoom) {
        if (event.code === 4004) showLobbyError('No room has that code. Check it, or start a new room.');
        else if (event.code === 4003) showLobbyError('That room is full (12 devices).');
        else showLobbyError('Could not reach the server. Check your connection and try again.');
        return;
      }

      if (event.code === 4004) {
        toast('This room has closed.');
        leaveRoom();
        return;
      }
      el.syncStatus.textContent = 'Connection lost. Reconnecting…';
      el.syncStatus.className = 'sync-status is-warn';
      reconnectTimer = setTimeout(() => connect(false), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.7, 8000);
    };
  }

  /* ---------------- joining and leaving ---------------- */

  function unlockAudio() {
    // Join is a tap or click, which lets the browser allow sound later.
    audio.src = SILENT_WAV;
    loadedTrackId = null;
    audio.play().catch(() => {});
  }

  function enterRoom(code, create) {
    const name = el.nameInput.value.trim().slice(0, 24) || randomName();
    code = cleanCode(code);
    if (code.length < 4) {
      showLobbyError('Enter a room code with at least 4 letters or numbers, or start a new room.');
      el.codeInput.focus();
      return;
    }
    showLobbyError('');
    store('unison-name', name);
    myName = name;
    roomCode = code;
    leaving = false;
    unlockAudio();
    connect(create);
  }

  function showRoomView() {
    inRoom = true;
    el.lobby.hidden = true;
    el.room.hidden = false;
    el.roomCode.textContent = roomCode;
    history.replaceState(null, '', `#${roomCode}`);
    document.title = `Room ${roomCode} · Unison`;
    resizeRing();
  }

  function leaveRoom() {
    leaving = true;
    inRoom = false;
    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);
    if (ws) { ws.close(); ws = null; }
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    loadedTrackId = null;
    state = null;
    el.room.hidden = true;
    el.lobby.hidden = false;
    el.soundGate.hidden = true;
    history.replaceState(null, '', location.pathname);
    document.title = 'Unison';
  }

  /* ---------------- applying room state ---------------- */

  function onState(snapshot) {
    state = snapshot;
    state.receivedAt = Date.now();
    if (!inRoom) showRoomView();
    renderRoom();
    syncAudio(true);
    updateStatus();
    updateSeekBar();
  }

  function currentTrack() {
    return state && state.index >= 0 ? state.tracks[state.index] : null;
  }

  // Where the shared timeline says the song should be right now.
  function targetPosition() {
    if (!state) return 0;
    if (!state.playing) return state.position;
    return state.position + (serverNow() - state.serverNow) / 1000;
  }

  function renderRoom() {
    const track = currentTrack();

    el.nowTitle.textContent = track ? track.title : 'Nothing queued yet';
    el.nowBy.textContent = track ? `Added by ${track.by}` : 'Add a song to start';

    const hasTracks = state.tracks.length > 0;
    el.playBtn.disabled = !hasTracks;
    el.prevBtn.disabled = !track;
    el.nextBtn.disabled = !track || state.index >= state.tracks.length - 1;
    // SVG elements have no .hidden property, so toggle the attribute directly.
    el.playIcon.toggleAttribute('hidden', state.playing);
    el.pauseIcon.toggleAttribute('hidden', !state.playing);
    el.playBtn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');

    // Devices
    el.members.textContent = '';
    state.members.forEach((m) => {
      const li = document.createElement('li');
      li.textContent = m.id === myId ? `${m.name} (you)` : m.name;
      if (m.id === myId) li.className = 'is-you';
      el.members.appendChild(li);
    });

    // Songs
    el.queueList.textContent = '';
    el.queueEmpty.hidden = hasTracks;
    state.tracks.forEach((t, i) => {
      const li = document.createElement('li');
      if (i === state.index) li.className = 'is-current';

      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'track-btn';
      play.dataset.action = 'select';
      play.dataset.index = String(i);
      if (i === state.index) play.setAttribute('aria-current', 'true');
      const title = document.createElement('span');
      title.className = 'track-title';
      title.textContent = t.title;
      const by = document.createElement('span');
      by.className = 'track-by';
      by.textContent = `Added by ${t.by}`;
      play.append(title, by);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove-btn';
      remove.dataset.action = 'remove';
      remove.dataset.id = t.id;
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${t.title}`);

      li.append(play, remove);
      el.queueList.appendChild(li);
    });
  }

  /* ---------------- audio sync ---------------- */

  function syncAudio(force) {
    if (!state) return;
    const track = currentTrack();

    if (!track) {
      if (loadedTrackId) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        loadedTrackId = null;
      }
      return;
    }

    if (loadedTrackId !== track.id) {
      loadedTrackId = track.id;
      audio.src = track.url;
      audio.load();
    }

    const target = targetPosition();

    if (!state.playing) {
      if (!audio.paused) audio.pause();
      audio.playbackRate = 1;
      if (audio.readyState > 0 && Math.abs(audio.currentTime - target) > 0.05) {
        audio.currentTime = target;
      }
      return;
    }

    if (audio.paused) {
      const attempt = audio.play();
      if (attempt && attempt.catch) attempt.catch(onPlayBlocked);
    }

    // Wait until enough of the file has loaded to know where we are.
    if (audio.readyState < 2) return;

    const drift = audio.currentTime - target; // positive = we are ahead
    const size = Math.abs(drift);

    if (size > 0.25 || (force && size > 0.08)) {
      audio.currentTime = target;
      audio.playbackRate = 1;
    } else if (size > 0.03) {
      // Small drift: speed up or slow down a touch instead of jumping.
      audio.playbackRate = 1 - Math.sign(drift) * Math.min(0.05, size * 0.5);
    } else {
      audio.playbackRate = 1;
    }
  }

  function onPlayBlocked(err) {
    if (err && err.name === 'NotAllowedError') el.soundGate.hidden = false;
  }

  audio.addEventListener('playing', () => { el.soundGate.hidden = true; });
  audio.addEventListener('loadedmetadata', () => syncAudio(true));
  audio.addEventListener('canplay', () => syncAudio(true));
  audio.addEventListener('ended', () => {
    if (loadedTrackId) send({ type: 'ended', id: loadedTrackId });
  });
  audio.addEventListener('error', () => {
    if (loadedTrackId) toast('This browser could not play that file. Try removing it and adding an MP3.');
  });

  setInterval(() => { if (inRoom) syncAudio(false); }, 400);

  el.soundBtn.addEventListener('click', () => {
    el.soundGate.hidden = true;
    syncAudio(true);
  });

  /* ---------------- status line, seek bar ---------------- */

  function updateStatus() {
    if (!inRoom || !state) return;
    if (ws && ws.readyState !== 1) return;

    const parts = [];
    let cls = 'sync-status';
    const track = currentTrack();

    if (track && state.playing && audio.readyState >= 2) {
      const drift = Math.round((audio.currentTime - targetPosition()) * 1000);
      if (Math.abs(drift) <= 60) {
        parts.push(`In sync (${drift >= 0 ? '+' : '−'}${Math.abs(drift)} ms)`);
        cls += ' is-good';
      } else {
        parts.push('Catching up…');
        cls += ' is-warn';
      }
    } else if (track && state.playing) {
      parts.push('Loading song…');
    } else if (track) {
      parts.push('Paused for everyone');
    } else {
      parts.push('Waiting for a song');
    }
    if (latencyMs !== null) parts.push(`Latency ${latencyMs} ms`);

    el.syncStatus.textContent = parts.join('  ·  ');
    el.syncStatus.className = cls;
  }
  setInterval(updateStatus, 1000);

  function updateSeekBar() {
    const duration = audio.duration;
    const ready = Number.isFinite(duration) && duration > 0 && currentTrack();
    el.seek.disabled = !ready;
    el.timeTotal.textContent = ready ? formatTime(duration) : '0:00';

    if (!seeking) {
      const position = ready ? Math.min(targetPosition(), duration) : 0;
      el.seek.value = ready ? String(Math.round((position / duration) * 1000)) : '0';
      el.timeNow.textContent = formatTime(position);
    }
  }
  setInterval(updateSeekBar, 250);

  el.seek.addEventListener('input', () => {
    seeking = true;
    const duration = audio.duration || 0;
    el.timeNow.textContent = formatTime((Number(el.seek.value) / 1000) * duration);
  });
  el.seek.addEventListener('change', () => {
    const duration = audio.duration || 0;
    send({ type: 'seek', position: (Number(el.seek.value) / 1000) * duration });
    seeking = false;
  });

  /* ---------------- controls ---------------- */

  el.playBtn.addEventListener('click', () => {
    if (!state) return;
    send({ type: state.playing ? 'pause' : 'play' });
    // This tap is a user gesture, so it is a safe moment to start sound locally.
    if (!state.playing) syncAudio(true);
  });
  el.prevBtn.addEventListener('click', () => send({ type: 'prev' }));
  el.nextBtn.addEventListener('click', () => send({ type: 'next' }));

  el.volume.addEventListener('input', () => {
    audio.volume = Number(el.volume.value) / 100;
  });

  el.queueList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'select') {
      send({ type: 'select', index: Number(button.dataset.index) });
    } else if (button.dataset.action === 'remove') {
      send({ type: 'remove', id: button.dataset.id });
    }
  });

  /* ---------------- uploads ---------------- */

  function uploadFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith('audio/') || AUDIO_NAME_RE.test(f.name));
    if (!files.length) {
      toast('Choose audio files such as MP3, M4A, WAV or FLAC.');
      return;
    }
    const tooBig = files.find((f) => f.size > MAX_FILE_MB * 1024 * 1024);
    if (tooBig) {
      toast(`"${tooBig.name}" is over ${MAX_FILE_MB} MB. Choose a smaller file.`);
      return;
    }

    const form = new FormData();
    files.forEach((f) => form.append('files', f));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/rooms/${encodeURIComponent(roomCode)}/tracks?by=${encodeURIComponent(myName)}`);

    el.uploadStatus.hidden = false;
    el.uploadStatus.textContent = 'Uploading…';
    el.addBtn.disabled = true;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) el.uploadStatus.textContent = `Uploading… ${Math.round((e.loaded / e.total) * 100)}%`;
    };
    const finish = () => {
      el.addBtn.disabled = false;
      el.uploadStatus.hidden = true;
      el.fileInput.value = '';
    };
    xhr.onload = () => {
      finish();
      if (xhr.status >= 200 && xhr.status < 300) {
        let added = files.length;
        try { added = JSON.parse(xhr.responseText).added; } catch { /* keep default */ }
        toast(added === 1 ? 'Song added.' : `${added} songs added.`);
      } else {
        let message = 'Upload failed. Try again.';
        try { message = JSON.parse(xhr.responseText).error || message; } catch { /* keep default */ }
        toast(message);
      }
    };
    xhr.onerror = () => {
      finish();
      toast('Upload failed. Check your connection and try again.');
    };
    xhr.send(form);
  }

  el.addBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    if (el.fileInput.files.length) uploadFiles(el.fileInput.files);
  });

  ['dragenter', 'dragover'].forEach((type) =>
    el.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      el.dropzone.classList.add('is-over');
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    el.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      el.dropzone.classList.remove('is-over');
    })
  );
  el.dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });

  /* ---------------- lobby and header buttons ---------------- */

  el.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    enterRoom(el.codeInput.value, false);
  });
  el.createBtn.addEventListener('click', () => enterRoom(randomCode(), true));
  el.leaveBtn.addEventListener('click', leaveRoom);

  el.copyBtn.addEventListener('click', async () => {
    const link = `${location.origin}/#${roomCode}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied.');
    } catch {
      toast(`Share this link: ${link}`);
    }
  });

  el.codeInput.addEventListener('input', () => {
    el.codeInput.value = cleanCode(el.codeInput.value);
  });

  /* ---------------- sync ring ---------------- */

  const ctx = el.ring.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const colors = { ink: '#16213a', line: '#c3cedb', signal: '#e8481f', paper: '#e6ecf1' };
  let ringSize = 0;

  function resizeRing() {
    const rect = el.ring.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = window.devicePixelRatio || 1;
    ringSize = rect.width;
    el.ring.width = Math.round(rect.width * dpr);
    el.ring.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resizeRing);

  let lastDraw = 0;
  function drawRing(now) {
    requestAnimationFrame(drawRing);
    if (!inRoom || !ringSize) return;
    if (reduceMotion && now - lastDraw < 250) return;
    lastDraw = now;

    const size = ringSize;
    const cx = size / 2;
    const cy = size / 2;
    const radius = size * 0.43;
    ctx.clearRect(0, 0, size, size);

    // Position on the shared timeline decides where the sweep points, so every
    // device in the room draws the same picture at the same moment.
    const track = currentTrack();
    const playing = state && state.playing && track && audio.readyState >= 2;
    const position = playing ? audio.currentTime : state ? state.position : 0;
    const angle = ((position % SWEEP_SECONDS) / SWEEP_SECONDS) * Math.PI * 2 - Math.PI / 2;

    // Ring
    ctx.lineWidth = 2;
    ctx.strokeStyle = colors.line;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Sweep trail
    if (track) {
      const trail = 1.1;
      const steps = 24;
      ctx.lineWidth = 6;
      ctx.lineCap = 'butt';
      for (let i = 0; i < steps; i++) {
        const a0 = angle - (trail * (i + 1)) / steps;
        const a1 = angle - (trail * i) / steps;
        ctx.strokeStyle = `rgba(232, 72, 31, ${(1 - i / steps) * (playing ? 0.55 : 0.25)})`;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, a0, a1);
        ctx.stroke();
      }
    }

    // Devices
    const members = state ? state.members : [];
    const n = Math.max(members.length, 1);
    members.forEach((m, i) => {
      const a = -Math.PI / 2 + (Math.PI * 2 * i) / n;
      const x = cx + Math.cos(a) * radius;
      const y = cy + Math.sin(a) * radius;

      // How recently the sweep passed this device (0 to 1).
      let behind = (angle - a) % (Math.PI * 2);
      if (behind < 0) behind += Math.PI * 2;
      const glow = playing && behind < 1.0 ? 1 - behind / 1.0 : 0;

      const r = 9 + glow * 7;
      ctx.fillStyle = glow > 0.02 ? colors.signal : colors.ink;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      if (m.id === myId) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = colors.ink;
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
    });

    // Sweep head
    if (track) {
      ctx.fillStyle = colors.signal;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  requestAnimationFrame(drawRing);

  /* ---------------- start up ---------------- */

  el.nameInput.value = store('unison-name') || randomName();

  const hashCode = cleanCode(location.hash.slice(1));
  if (hashCode) {
    el.codeInput.value = hashCode;
    el.nameInput.focus();
  }
})();
