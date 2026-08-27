'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const COLUMNS = ['be', 'fe'];
const DISCONNECT_GRACE_MS = 15000;
const MAX_NAME_LENGTH = 24;
const VALUE_PATTERN = /^(\?|\d{1,3}(\.\d)?)$/;

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/** id -> { id, name, votes: { be, fe }, dropTimer } */
const participants = new Map();
/** open SSE response -> the participant id watching it (may be null) */
const streams = new Map();
/** participant id -> number of open SSE responses for that id */
const streamCounts = new Map();

let revealed = false;
let round = 1;

// ---------------------------------------------------------------- state

function summarise(column) {
  const numbers = [...participants.values()]
    .map((p) => p.votes[column])
    .filter((v) => v !== null && v !== '?')
    .map(Number);

  if (numbers.length === 0) {
    return { average: null, min: null, max: null, agreed: false };
  }
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const average = numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
  return {
    average: Math.round(average * 10) / 10,
    min,
    max,
    agreed: min === max && numbers.length > 1,
  };
}

// Votes are masked for everyone but their owner, who needs them back after a refresh.
function stateFor(viewerId) {
  return {
    round,
    revealed,
    participants: [...participants.values()].map((p) => ({
      id: p.id,
      name: p.name,
      votes: Object.fromEntries(
        COLUMNS.map((c) => [
          c,
          {
            voted: p.votes[c] !== null,
            value: revealed || p.id === viewerId ? p.votes[c] : null,
          },
        ])
      ),
    })),
    summary: revealed
      ? Object.fromEntries(COLUMNS.map((c) => [c, summarise(c)]))
      : null,
  };
}

function broadcast() {
  const payloads = new Map();
  for (const [stream, viewerId] of streams) {
    if (!payloads.has(viewerId)) {
      payloads.set(viewerId, `data: ${JSON.stringify(stateFor(viewerId))}\n\n`);
    }
    stream.write(payloads.get(viewerId));
  }
}

// ---------------------------------------------------------------- mutations

function scheduleDrop(id) {
  const participant = participants.get(id);
  if (!participant || participant.dropTimer) return;
  participant.dropTimer = setTimeout(() => {
    participants.delete(id);
    broadcast();
  }, DISCONNECT_GRACE_MS);
}

function cancelDrop(id) {
  const participant = participants.get(id);
  if (!participant || !participant.dropTimer) return;
  clearTimeout(participant.dropTimer);
  participant.dropTimer = null;
}

function upsertParticipant(id, name) {
  const existing = participants.get(id);
  if (existing) {
    existing.name = name;
    return existing;
  }
  participants.set(id, { id, name, votes: { be: null, fe: null }, dropTimer: null });
  // Nobody is listening for this id yet, so drop it again unless a stream shows up.
  if (!streamCounts.has(id)) scheduleDrop(id);
}

function clearVotes() {
  for (const participant of participants.values()) {
    for (const column of COLUMNS) participant.votes[column] = null;
  }
}

// ---------------------------------------------------------------- http

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4096) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(PUBLIC_DIR, path.normalize(requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const id = new URL(req.url, 'http://localhost').searchParams.get('id');
  res.write('retry: 2000\n\n');
  res.write(`data: ${JSON.stringify(stateFor(id))}\n\n`);
  streams.set(res, id);

  if (id) {
    streamCounts.set(id, (streamCounts.get(id) || 0) + 1);
    cancelDrop(id);
  }
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

  // 'close' on the response (not the request) is what tells us the client hung up.
  res.on('close', () => {
    clearInterval(keepAlive);
    streams.delete(res);
    if (!id) return;
    const remaining = (streamCounts.get(id) || 1) - 1;
    if (remaining > 0) {
      streamCounts.set(id, remaining);
    } else {
      streamCounts.delete(id);
      scheduleDrop(id);
    }
  });
}

const routes = {
  '/api/join': (body) => {
    const id = String(body.id || '').slice(0, 64);
    const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
    if (!id || !name) return { status: 400, body: { error: 'id and name are required' } };
    upsertParticipant(id, name);
    return { status: 200, body: { ok: true } };
  },

  '/api/vote': (body) => {
    const participant = participants.get(String(body.id || ''));
    const column = String(body.column || '');
    const value = body.value === null || body.value === '' ? null : String(body.value);
    if (!participant) return { status: 404, body: { error: 'join first' } };
    if (!COLUMNS.includes(column)) return { status: 400, body: { error: 'unknown column' } };
    if (value !== null && !VALUE_PATTERN.test(value)) {
      return { status: 400, body: { error: 'value must be a number or ?' } };
    }
    if (revealed) return { status: 409, body: { error: 'round already revealed' } };
    participant.votes[column] = value;
    return { status: 200, body: { ok: true } };
  },

  '/api/reveal': () => {
    revealed = true;
    return { status: 200, body: { ok: true } };
  },

  '/api/reset': () => {
    revealed = false;
    round += 1;
    clearVotes();
    return { status: 200, body: { ok: true } };
  },
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/api/events')) {
    openStream(req, res);
    return;
  }
  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }
  if (req.method === 'POST') {
    const route = routes[req.url.split('?')[0]];
    if (!route) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    try {
      const result = route(await readJsonBody(req));
      sendJson(res, result.status, result.body);
      if (result.status === 200) broadcast();
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }
  res.writeHead(405).end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`Scrum poker running at http://localhost:${PORT}`);
});
