require('dotenv/config');

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_HTTP_BODY = 7 * 1024 * 1024;
const MAX_ROOM_MESSAGE = 1024 * 1024;
const MAX_ROOMS = 500;
const MAX_ROOM_CLIENTS = 8;
const MAX_CLIENTS = 200;
const MAX_IMAGE_REQUESTS_PER_HOUR = 10;
const ROOM_CODE = /^[A-F0-9]{10}$/;
const ART_PATTERNS = new Set(['plain', 'stripes', 'chevron', 'spots', 'gradient', 'camo', 'stealth']);
const FACE_KINDS = new Set(['center', 'edge', 'wing', 'tail', 'nose', 'lock', 'squash', 'waterbomb', 'crease', 'winglet']);
const rooms = new Map();
const imageRequestWindows = new Map();
const peers = new WeakMap();
const root = __dirname;
const server = http.createServer(handleRequest);
const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_ROOM_MESSAGE });

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

function sendPeer(peer, value) {
  if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(value));
}

async function readJson(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function finiteRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function validImageDesign(value) {
  if (!value || typeof value !== 'object') return false;
  const geometry = value.geometry;
  const art = value.art;
  if (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 80) return false;
  if (typeof value.description !== 'string' || value.description.length < 1 || value.description.length > 400) return false;
  if (!geometry || !finiteRange(geometry.startX, 0.15, 1.15) ||
      !finiteRange(geometry.rootY, 2.4, 5.6) ||
      !finiteRange(geometry.tipY, 7.6, 10) ||
      !finiteRange(geometry.noseY, 2.3, 4.2) ||
      !(geometry.lockY === null || finiteRange(geometry.lockY, 1.5, 3)) ||
      !finiteRange(geometry.widthTarget, 0.25, 0.8) ||
      !['valley', 'mountain'].includes(geometry.foldType) ||
      geometry.tipY - geometry.rootY < 2) return false;
  if (!art || !['primary', 'secondary', 'accent'].every(key => /^#[\da-f]{6}$/i.test(art[key] || '')) ||
      !ART_PATTERNS.has(art.pattern)) return false;
  return true;
}

function imageEndpoint() {
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function allowImageRequest(ip) {
  const now = Date.now(), window = imageRequestWindows.get(ip);
  if (!window || now - window.startedAt >= 60 * 60 * 1000) {
    imageRequestWindows.set(ip, { startedAt: now, count: 1 });
    if (imageRequestWindows.size > 5000) {
      for (const [address, entry] of imageRequestWindows) {
        if (now - entry.startedAt >= 60 * 60 * 1000) imageRequestWindows.delete(address);
      }
    }
    return true;
  }
  if (window.count >= MAX_IMAGE_REQUESTS_PER_HOUR) return false;
  window.count++;
  return true;
}

async function createPlaneFromImage(request, response) {
  if (!process.env.OPENAI_API_KEY) {
    sendJson(response, 503, { error: 'AI image conversion is not configured. Set OPENAI_API_KEY on the server.' });
    return;
  }

  let body;
  try {
    body = await readJson(request, MAX_HTTP_BODY);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message });
    return;
  }

  const match = body && typeof body.imageData === 'string'
    ? body.imageData.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/)
    : null;
  if (!match) {
    sendJson(response, 400, { error: 'Upload a PNG, JPEG, or WebP image.' });
    return;
  }
  const image = Buffer.from(match[2], 'base64');
  if (!image.length || image.length > MAX_IMAGE_BYTES) {
    sendJson(response, 413, { error: 'Image must be smaller than 5 MB.' });
    return;
  }
  if (!allowImageRequest(request.socket.remoteAddress || 'unknown')) {
    sendJson(response, 429, { error: 'Image conversion limit reached for this connection. Try again in an hour.' });
    return;
  }

  const prompt = `Analyze the main object's silhouette and proportions in this image. Convert it into a buildable folded-paper airplane whose planform resembles that shape as closely as possible. Return only a JSON object with this exact schema:
{"name":"short plane name","description":"short English description using terms like dart, glider, wide, narrow, swept, stable, fast, and winglets","geometry":{"startX":0.55,"rootY":3.6,"tipY":9.2,"noseY":3.3,"lockY":null,"widthTarget":0.55,"foldType":"valley"},"art":{"primary":"#ffffff","secondary":"#2e65ff","accent":"#ff7043","pattern":"plain"}}
Geometry limits: startX 0.15-1.15, rootY 2.4-5.6, tipY 7.6-10 and at least 2 greater than rootY, noseY 2.3-4.2, lockY null or 1.5-3, widthTarget 0.25-0.8, foldType valley or mountain. Choose narrower wings for a long narrow silhouette, wider wings for a broad silhouette, and reflect the image's sweep in startX/rootY/tipY. Choose three valid six-digit hex colors sampled or inferred from the image. pattern must be plain, stripes, chevron, spots, gradient, camo, or stealth. Do not copy text or logos from the image.`;

  try {
    const upstream = await fetch(imageEndpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        max_tokens: 500,
        messages: [
          { role: 'system', content: 'You are a paper-airplane geometry designer. Follow the requested JSON schema exactly.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: body.imageData, detail: 'high' } }
            ]
          }
        ]
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (!upstream.ok) {
      console.error(`Vision provider returned HTTP ${upstream.status}.`);
      sendJson(response, 502, { error: `AI provider request failed (HTTP ${upstream.status}). Check the server model and provider settings.` });
      return;
    }
    const result = await upstream.json();
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('The AI provider returned no design content.');
    const design = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!validImageDesign(design)) throw new Error('The AI provider returned invalid plane geometry.');
    sendJson(response, 200, { design });
  } catch (error) {
    console.error('AI image conversion failed:', error.message);
    const timedOut = error.name === 'TimeoutError';
    sendJson(response, timedOut ? 504 : 502, {
      error: timedOut ? 'AI image conversion timed out. Please try again.' : 'AI image conversion failed. Check the provider configuration and try again.'
    });
  }
}

function validPoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    Math.abs(point.x) <= 1000 && Math.abs(point.y) <= 1000;
}

function validFaces(faces) {
  return Array.isArray(faces) && faces.length <= 2500 && faces.every(face =>
    face && Array.isArray(face.points) && face.points.length >= 3 && face.points.length <= 80 &&
    face.points.every(validPoint) && Number.isInteger(face.layer || 0) &&
    (face.layer || 0) >= 0 && (face.layer || 0) <= 10000 &&
    typeof face.folded === 'boolean' &&
    (face.foldType === undefined || ['valley', 'mountain'].includes(face.foldType))
  );
}

function validRoomState(state) {
  if (!state || typeof state !== 'object' || !validFaces(state.faces) ||
      !Array.isArray(state.creases) || state.creases.length > 500) return false;
  const creaseValid = crease => crease && validPoint(crease.a) && validPoint(crease.b) &&
    ['valley', 'mountain'].includes(crease.type) && FACE_KINDS.has(crease.kind) &&
    (crease.side === undefined || crease.side === null || crease.side === -1 || crease.side === 1) &&
    (crease.layer === undefined || Number.isInteger(crease.layer) && crease.layer >= 0 && crease.layer <= 10000) &&
    (crease.instruction === undefined || typeof crease.instruction === 'string' && crease.instruction.length <= 300) &&
    (crease.beforeFaces === undefined || validFaces(crease.beforeFaces));
  if (!state.creases.every(creaseValid)) return false;
  if (state.art !== undefined) {
    const art = state.art;
    if (!art || typeof art.enabled !== 'boolean' || !ART_PATTERNS.has(art.pattern) ||
        !['primary', 'secondary', 'accent'].every(key => /^#[\da-f]{6}$/i.test(art[key] || '')) ||
        typeof art.text !== 'string' || art.text.length > 18 ||
        typeof art.imageSrc !== 'string' || art.imageSrc.length > 300000 ||
        art.imageSrc && !/^data:image\/(?:png|jpeg|webp|gif|svg\+xml|avif|bmp);base64,[A-Za-z0-9+/]+={0,2}$/.test(art.imageSrc)) return false;
  }
  return state.rotation === undefined || [0, 90, 180, 270].includes(state.rotation);
}

function leaveRoom(peer) {
  const meta = peers.get(peer);
  if (!meta?.roomCode) return;
  const room = rooms.get(meta.roomCode);
  meta.roomCode = null;
  if (!room) return;
  room.members.delete(peer);
  if (!room.members.size) {
    rooms.delete(room.code);
    return;
  }
  for (const member of room.members) sendPeer(member, { type: 'presence', count: room.members.size });
}

function joinRoom(peer, code, create = false) {
  if (peers.get(peer).roomCode) {
    sendPeer(peer, { type: 'error', message: 'Leave your current room before joining another.' });
    return;
  }
  let room;
  if (create) {
    if (rooms.size >= MAX_ROOMS) {
      sendPeer(peer, { type: 'error', message: 'The server is at its room limit. Try again later.' });
      return;
    }
    do { code = crypto.randomBytes(5).toString('hex').toUpperCase() } while (rooms.has(code));
    room = { code, members: new Set(), state: null };
    rooms.set(code, room);
  } else {
    room = rooms.get(code);
  }
  if (!room) {
    sendPeer(peer, { type: 'error', message: 'Room not found. Check the code or ask for a new invite.' });
    return;
  }
  if (room.members.size >= MAX_ROOM_CLIENTS) {
    sendPeer(peer, { type: 'error', message: 'That room is full (maximum 8 people).' });
    return;
  }
  room.members.add(peer);
  peers.get(peer).roomCode = code;
  sendPeer(peer, { type: 'room', code, count: room.members.size, state: room.state });
  for (const member of room.members) {
    if (member !== peer) sendPeer(member, { type: 'presence', count: room.members.size });
  }
}

webSocketServer.on('connection', peer => {
  if (webSocketServer.clients.size > MAX_CLIENTS) {
    peer.close(1013, 'Server is full.');
    return;
  }
  peers.set(peer, { roomCode: null, windowStartedAt: Date.now(), messageCount: 0 });
  peer.on('message', raw => {
    const meta = peers.get(peer);
    const now = Date.now();
    if (now - meta.windowStartedAt > 5000) {
      meta.windowStartedAt = now;
      meta.messageCount = 0;
    }
    if (++meta.messageCount > 40) {
      sendPeer(peer, { type: 'error', message: 'Too many updates. Please slow down.' });
      return;
    }
    let message;
    try { message = JSON.parse(raw.toString()); }
    catch {
      sendPeer(peer, { type: 'error', message: 'Invalid room message.' });
      return;
    }
    if (message.type === 'create') {
      joinRoom(peer, '', true);
      return;
    }
    if (message.type === 'join') {
      const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
      if (!ROOM_CODE.test(code)) {
        sendPeer(peer, { type: 'error', message: 'Room codes must contain 10 hexadecimal characters.' });
        return;
      }
      joinRoom(peer, code);
      return;
    }
    const room = rooms.get(meta.roomCode);
    if (message.type === 'state' && room) {
      if (!validRoomState(message.state)) {
        sendPeer(peer, { type: 'error', message: 'Plane state could not be shared. Try simplifying the design.' });
        return;
      }
      room.state = message.state;
      for (const member of room.members) {
        if (member !== peer) sendPeer(member, { type: 'state', state: room.state });
      }
      return;
    }
    sendPeer(peer, { type: 'error', message: 'Join a room before sending updates.' });
  });
  peer.on('close', () => leaveRoom(peer));
  peer.on('error', error => console.error('Room socket error:', error.message));
});

server.on('upgrade', (request, socket, head) => {
  let pathname;
  try { pathname = new URL(request.url, 'http://localhost').pathname; }
  catch { socket.destroy(); return; }
  const origin = request.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== request.headers.host) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    } catch {
      socket.destroy();
      return;
    }
  }
  if (pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, peer => {
    webSocketServer.emit('connection', peer, request);
  });
});

async function handleRequest(request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:");
  let pathname;
  try { pathname = new URL(request.url, 'http://localhost').pathname; }
  catch {
    sendJson(response, 400, { error: 'Invalid request URL.' });
    return;
  }
  if (pathname === '/healthz' && request.method === 'GET') {
    sendJson(response, 200, { status: 'ok', aiConfigured: Boolean(process.env.OPENAI_API_KEY) });
    return;
  }
  if (pathname === '/api/image-to-plane') {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      sendJson(response, 405, { error: 'Use POST for image conversion.' });
      return;
    }
    const origin = request.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== request.headers.host) {
          sendJson(response, 403, { error: 'Image conversion is only available from this app.' });
          return;
        }
      } catch {
        sendJson(response, 403, { error: 'Invalid request origin.' });
        return;
      }
    }
    await createPlaneFromImage(request, response);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return;
  }
  const file = pathname === '/' || pathname === '/index.html'
    ? path.join(root, 'index.html')
    : pathname === '/favicon.ico' ? path.join(root, 'favicon.ico') : null;
  if (!file) {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }
  fs.readFile(file, (error, content) => {
    if (error) {
      sendJson(response, 500, { error: 'Could not load the app.' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'image/x-icon',
      'Cache-Control': 'no-store',
      'Content-Length': content.length
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Fold Lab listening at http://${HOST}:${PORT}.`);
});

function shutdown() {
  for (const peer of webSocketServer.clients) peer.close(1001, 'Server shutting down.');
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
