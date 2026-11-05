# Unison

Listening rooms where every device plays the same song at the same moment. Open a room on several phones and laptops, add songs, press play, and the devices sound like one big speaker.

## Run it

You need Node.js 18 or newer.

```bash
npm install
npm start
```

The terminal prints two addresses:

- **This computer:** `http://localhost:3000`
- **Other devices:** `http://<your-ip>:3000` (phones and laptops on the same Wi-Fi)

Open one of them, choose **Start a new room**, then press **Copy invite link** and open that link on your other devices. To use a different port: `PORT=8080 npm start`.

## Use it

1. Start a room on one device. It gets a 5-character code.
2. Join from the other devices with the invite link, or type the code.
3. Choose **Add songs** and pick audio files from your device (MP3, M4A, WAV, OGG, FLAC, OPUS; up to 40 MB each). You can also drop files onto the song list.
4. Press play. Anyone in the room can play, pause, seek, skip or remove songs.
5. Each device has its own volume slider.

The ring shows the devices in the room. The orange sweep makes one lap every 4 seconds of song time, so it points at the same spot on every device when they are in sync. The line under the controls shows how far this device is from the shared timeline.

## How the sync works

- The server keeps one shared timeline per room: the song position at a moment on the server's clock.
- Each device measures how far its own clock is from the server's (several quick pings, keeping the fastest round trip) and uses that to work out where in the song it should be right now.
- Every 400 ms the device compares its audio position to that target. A small drift is corrected by speeding up or slowing down playback by a few percent. A drift over 0.25 seconds is corrected with a jump.
- When a song ends, the first device to report it moves the room to the next song.

## Good to know

- **Accuracy:** devices on the same network usually stay within about 50 ms of each other. Bluetooth speakers and some wireless headphones add their own delay, which the app cannot see. If one device sounds late, use a wired or built-in speaker there.
- **Sound on phones:** browsers only start sound after a tap. Joining a room counts as that tap. If sound is blocked anyway, a **Turn on sound** button appears.
- **Privacy:** there are no accounts. Anyone with the room code can join and add songs. Uploaded files live on the server only while the room exists. They are deleted 10 minutes after the last device leaves, and every time the server starts.
- **Limits:** 12 devices and 30 songs per room.
- **Using it over the internet:** run it on a server and put it behind HTTPS (for example with Caddy or nginx). The app switches to secure WebSockets automatically on HTTPS.

## Files

- `server.js`: rooms, shared timeline, WebSocket messages, uploads.
- `public/index.html`, `public/style.css`, `public/app.js`: the app.
