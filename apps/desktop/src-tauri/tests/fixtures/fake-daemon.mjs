// Fake Core Daemon for the Tauri shell tests (src/daemon.rs). Mimics the contract in
// docs/persistent/architecture.md §2.1: bind 127.0.0.1:<ACC_PORT>, write
// <ACC_HOME>/daemon.json atomically AFTER listen succeeds, serve GET /health, and exit 0
// when the port is taken (lost the start race).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const home = process.env.ACC_HOME || path.join(os.homedir(), '.acc');
const port = Number(process.env.ACC_PORT || 47821);
const token = crypto.randomBytes(24).toString('base64url');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/health') {
    const body = JSON.stringify({ ok: true, service: 'acc-daemon', pid: process.pid, version: '0.0.0-test' });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  res.writeHead(404).end();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') process.exit(0);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  fs.mkdirSync(home, { recursive: true });
  const tmp = path.join(home, `daemon.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  fs.renameSync(tmp, path.join(home, 'daemon.json'));
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0));
