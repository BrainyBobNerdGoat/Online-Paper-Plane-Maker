Install Node.js 20 or newer.
From this folder, run npm install.
Copy .env.example to .env and set OPENAI_API_KEY and, if needed, OPENAI_BASE_URL / OPENAI_MODEL. The server loads .env automatically.
From this folder, run npm start.
Open http://localhost:3000.
The API key is only read by server.js; never put it in index.html or commit it. The AI endpoint returns a clear configuration error until a key is set. Image conversion supports PNG, JPEG, and WebP files up to 5 MB. The uploaded image is sent to the configured OpenAI-compatible vision endpoint. The server binds to localhost by default; set HOST=0.0.0.0 in your deployment environment to accept connections through a public host.

Online rooms
Create a room and share its invite link. Room members see the same plane and edits are broadcast live; concurrent edits use last-update-wins behavior. Room codes act as bearer invites: anyone with the code/link can edit. Rooms are held in memory and disappear when empty or when the server restarts. Deploy this server on a host reachable over HTTPS/WSS for online use; do not expose the unencrypted WebSocket endpoint on a public network.

The server limits rooms to 8 connected people and image conversions to 10 per client IP per hour. It does not provide accounts, persistent history, or private access controls.
