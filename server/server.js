#!/usr/bin/env node
/* Photo Mirror local server. No dependencies: needs only Node 18 or newer.
   Serves the laptop viewer (localhost only) and the phone page (paired devices only),
   keeps received photos and files on disk, and pushes live updates over Server-Sent Events. */
'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', csv: 'text/csv', mp4: 'video/mp4', mp3: 'audio/mpeg', json: 'application/json' };
const PHOTO_RE = /^\d+(?:-\d+)?\.jpg$/, ID_RE = /^[\w-]{3,60}$/;

/* ---------- self-signed certificate, built by hand so no tools or packages are needed ---------- */
function der(tag, ...parts) {
  const body = Buffer.concat(parts); let len;
  if (body.length < 128) len = Buffer.from([body.length]);
  else { const b = []; let n = body.length; while (n) { b.unshift(n & 255); n >>= 8; } len = Buffer.from([0x80 | b.length, ...b]); }
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...p) => der(0x30, ...p), set = (...p) => der(0x31, ...p);
const oid = s => { const a = s.split('.').map(Number), b = [a[0] * 40 + a[1]]; for (let i = 2; i < a.length; i++) { let v = a[i]; const t = [v & 127]; v >>= 7; while (v) { t.unshift((v & 127) | 128); v >>= 7; } b.push(...t); } return der(0x06, Buffer.from(b)); };
const utf8 = s => der(0x0c, Buffer.from(s)), bitstr = b => der(0x03, Buffer.concat([Buffer.from([0]), b]));
const utc = d => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
function makeCert(ips) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sigAlg = seq(oid('1.2.840.113549.1.1.11'), der(0x05));
  const name = seq(set(seq(oid('2.5.4.3'), utf8('Photo Mirror'))));
  const san = seq(der(0x82, Buffer.from('localhost')), ...ips.map(ip => der(0x87, Buffer.from(ip.split('.').map(Number)))));
  const ext = seq(
    seq(oid('2.5.29.17'), der(0x04, san)),
    seq(oid('2.5.29.19'), der(0x01, Buffer.from([0xff])), der(0x04, seq())),
    seq(oid('2.5.29.37'), der(0x04, seq(oid('1.3.6.1.5.5.7.3.1'))))
  );
  const serial = crypto.randomBytes(8); serial[0] &= 0x7f; if (!serial[0]) serial[0] = 1;
  const from = new Date(Date.now() - 864e5), to = new Date(Date.now() + 800 * 864e5);
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), sigAlg, name, seq(utc(from), utc(to)), name,
    publicKey.export({ type: 'spki', format: 'der' }), der(0xa3, ext));
  const cert = seq(tbs, sigAlg, bitstr(crypto.sign('sha256', tbs, privateKey)));
  const pem = '-----BEGIN CERTIFICATE-----\n' + cert.toString('base64').replace(/(.{64})/g, '$1\n').trim() + '\n-----END CERTIFICATE-----\n';
  return { cert: pem, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  const rank = a => /^192\.168\./.test(a) ? 0 : /^10\./.test(a) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3;
  return out.sort((a, b) => rank(a) - rank(b));
}

function create(opts = {}) {
  const dataDir = opts.dataDir || process.env.PM_DATA || path.join(os.homedir(), '.photo-mirror');
  const appDir = opts.appDir || process.env.PM_APP || path.join(__dirname, '..', 'app');
  const allowShutdown = opts.allowShutdown !== undefined ? opts.allowShutdown : process.env.PM_NO_SHUTDOWN !== '1';
  const D = n => path.join(dataDir, n);
  ['photos', 'trash', 'in', 'out'].forEach(d => fs.mkdirSync(D(d), { recursive: true }));
  const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(D(f), 'utf8')); } catch (e) { return d; } };
  const writeJSON = (f, v) => { const t = D(f) + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, D(f)); };

  let devices = readJSON('devices.json', []);               // {id, name, made, token}
  let files = readJSON('files.json', []);                   // {id, name, size, dir, mime}
  const codes = new Map();                                  // pairing code -> {exp, host}
  const viewers = new Set(), phonesSse = new Set();
  const ver = {}, ocrCache = new Map();
  let ports = { http: 0, https: 0 }, servers = [];

  const photoList = () => fs.readdirSync(D('photos')).filter(n => PHOTO_RE.test(n)).sort((a, b) => parseInt(a) - parseInt(b));
  /* tidy the trash: keep a week */
  try { for (const n of fs.readdirSync(D('trash'))) { const p = D('trash/' + n); if (Date.now() - fs.statSync(p).mtimeMs > 7 * 864e5) fs.unlinkSync(p); } } catch (e) {}

  const sse = (res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.write('retry: 2000\n\n'); };
  const RAW = new Set(['phones', 'devices']);   // these two carry plain text, everything else is JSON
  const send = (set, ev, data) => { const m = 'event: ' + ev + '\ndata: ' + (RAW.has(ev) ? String(data) : JSON.stringify(data)) + '\n\n'; for (const r of set) { try { r.write(m); } catch (e) {} } };
  const emitPhones = () => send(viewers, 'phones', String(phonesSse.size));
  setInterval(() => { for (const r of [...viewers, ...phonesSse]) { try { r.write(': ping\n\n'); } catch (e) {} } }, 25000).unref();

  let tessCache = null;                                      // installed Tesseract languages, looked up once
  const tessLangs = cb => {
    if (tessCache !== null) return cb(tessCache || null);
    execFile('tesseract', ['--list-langs'], { timeout: 10000 }, (err, out) => { tessCache = err ? false : new Set(String(out).split('\n').slice(1).map(x => x.trim()).filter(Boolean)); cb(tessCache || null); });
  };
  const sniff = b => b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : b[0] === 0x89 && b[1] === 0x50 ? 'png' : b.slice(0, 3).toString() === 'GIF' ? 'gif' : b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' ? 'webp' : '';
  const isLoop = a => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  const hostOf = req => String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  const ownHost = h => h === 'localhost' || h === '127.0.0.1' || h === '::1' || lanIPs().includes(h);
  const cookie = req => { const m = /(?:^|;\s*)pm_dev=([a-f0-9]{48})/.exec(req.headers.cookie || ''); return m ? m[1] : ''; };
  const deviceFor = req => { const t = cookie(req) || (/^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization || '') || [])[1]; return t ? devices.find(d => d.token === t) : null; };
  const deny = (res, code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg || ''); };
  const json = (res, v, code) => { res.writeHead(code || 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(v)); };
  const safeName = n => String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150) || 'file';

  function saveBody(req, dest, limit) {                     // stream the request to disk, return bytes
    return new Promise((resolve, reject) => {
      const tmp = dest + '.part'; const ws = fs.createWriteStream(tmp); let n = 0, bad = false;
      req.on('data', c => { n += c.length; if (n > limit && !bad) { bad = true; ws.destroy(); req.destroy(); fs.unlink(tmp, () => {}); reject(new Error('too large')); } });
      req.pipe(ws);
      ws.on('finish', () => { if (bad) return; fs.rename(tmp, dest, e => e ? reject(e) : resolve(n)); });
      ws.on('error', e => { fs.unlink(tmp, () => {}); reject(e); }); req.on('error', e => { fs.unlink(tmp, () => {}); reject(e); });
    });
  }
  function nextPhotoName() { let t = Date.now(), n; do { n = t + '.jpg'; t++; } while (fs.existsSync(D('photos/' + n))); return n; }

  async function addPhoto(req, res) {
    const tmp = D('photos/.up-' + crypto.randomBytes(4).toString('hex'));
    try {
      await saveBody(req, tmp, 60 * 1048576);
      const head = Buffer.alloc(12), fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 12, 0); fs.closeSync(fd);
      if (!sniff(head)) { fs.unlinkSync(tmp); return deny(res, 415, 'Not a supported image'); }
      const name = nextPhotoName(); fs.renameSync(tmp, D('photos/' + name));
      send(viewers, 'photo', name); json(res, { ok: true, name });
    } catch (e) { fs.unlink(tmp, () => {}); deny(res, 413, 'Upload failed'); }
  }
  async function addFile(req, res, url, dir) {
    const id = Date.now() + '-' + crypto.randomBytes(2).toString('hex'), name = safeName(url.searchParams.get('name'));
    const dest = D(dir + '/' + id);
    try {
      const size = await saveBody(req, dest, 4 * 1073741824);
      const f = { id, name, size, dir, mime: MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream' };
      files.push(f); writeJSON('files.json', files);
      send(viewers, 'file', f);
      json(res, { ok: true, id });
    } catch (e) { deny(res, 413, 'Upload failed'); }
  }
  function serveFile(req, res, p, name, mime, inline) {
    let st; try { st = fs.statSync(p); } catch (e) { return deny(res, 404, 'Not found'); }
    const h = { 'Content-Type': mime, 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' };
    if (name) h['Content-Disposition'] = (inline && /^(image|text|application\/pdf|video|audio)/.test(mime) ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name);
    res.writeHead(200, h); fs.createReadStream(p).pipe(res);
  }
  const fileOf = (dir, id) => files.find(f => f.dir === dir && f.id === id);
  function deviceName(ua) { ua = ua || ''; return /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android phone' : 'Phone'; }
  function origin(host, secure) { return (secure ? 'https://' : 'http://') + host + ':' + (secure ? ports.https : ports.http); }

  async function handle(req, res, secure) {
    const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    const loopOwner = isLoop(req.socket.remoteAddress) && ownHost(hostOf(req));
    const extOrigin = /^(chrome|moz)-extension:\/\/[\w-]+$/.test(req.headers.origin || '');   // the Photo Mirror browser extension (read-only)
    if (extOrigin && loopOwner) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin'); if (m === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' }); return res.end(); } }
    const viewerOnly = () => {
      if (!loopOwner) { deny(res, 403, 'This page only works on the computer running Photo Mirror.'); return false; }
      if (extOrigin) { if (m === 'GET') return true; deny(res, 403, 'Blocked'); return false; }
      const o = req.headers.origin; if (o && m !== 'GET') { try { if (new URL(o).host !== req.headers.host) { deny(res, 403, 'Blocked'); return false; } } catch (e) { deny(res, 403, 'Blocked'); return false; } }
      if (req.headers['sec-fetch-site'] === 'cross-site') { deny(res, 403, 'Blocked'); return false; }
      return true;
    };
    const phoneOnly = () => { const d = deviceFor(req); if (d) return d; deny(res, 401, 'Not paired'); return null; };

    /* ----- pages and static ----- */
    if (m === 'GET' && (p === '/' || p === '/viewer.html')) { if (!viewerOnly()) return; res.setHeader('Content-Security-Policy', "frame-ancestors 'self' chrome-extension: moz-extension:"); return serveFile(req, res, path.join(appDir, 'viewer.html'), null, 'text/html; charset=utf-8'); }
    if (m === 'GET' && p === '/phone') return serveFile(req, res, path.join(appDir, 'phone.html'), null, 'text/html; charset=utf-8');
    if (m === 'GET' && (p === '/icon.svg' || p === '/manifest.json')) return serveFile(req, res, path.join(appDir, p.slice(1)), null, MIME[p.split('.').pop()]);
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    /* ----- pairing (phone side) ----- */
    let mm;
    if (m === 'GET' && (mm = /^\/p\/([A-Za-z0-9]{6,20})$/.exec(p))) {
      const c = codes.get(mm[1]); codes.delete(mm[1]);
      if (!c || c.exp < Date.now()) { res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<meta name=viewport content="width=device-width,initial-scale=1"><body style="font:18px system-ui;padding:32px;text-align:center"><h2>This code has expired</h2><p>Codes work once and last 5 minutes. Press <b>New code</b> on your computer and scan it again.</p>'); }
      const token = crypto.randomBytes(24).toString('hex');
      devices.push({ id: crypto.randomBytes(4).toString('hex'), name: deviceName(req.headers['user-agent']), made: Date.now(), token }); writeJSON('devices.json', devices);
      send(viewers, 'devices', '');
      res.writeHead(302, { Location: '/phone', 'Set-Cookie': 'pm_dev=' + token + '; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax', 'Cache-Control': 'no-store' }); return res.end();
    }

    /* ----- phone endpoints ----- */
    if (m === 'GET' && p === '/ping') { if (!phoneOnly()) return; res.writeHead(200, { 'Cache-Control': 'no-store' }); return res.end('ok'); }
    if (m === 'GET' && p === '/info') return json(res, { secure: !!ports.https, port: ports.https });
    if (m === 'POST' && p === '/upload') { if (!phoneOnly()) return; return addPhoto(req, res); }
    if (m === 'POST' && p === '/file-up') { if (!phoneOnly()) return; return addFile(req, res, url, 'in'); }
    if (m === 'GET' && p === '/phone-events') {                 // the phone only listens so the computer can count connected phones
      if (!phoneOnly()) return; sse(res); phonesSse.add(res); emitPhones();
      req.on('close', () => { phonesSse.delete(res); emitPhones(); }); return;
    }
    if ((mm = /^\/s\/([a-f0-9]{48})$/.exec(p)) && m === 'POST') {       // phone shortcut key
      const d = devices.find(x => x.token === mm[1]); if (!d) return deny(res, 401, 'Unknown key');
      return url.searchParams.get('name') ? addFile(req, res, url, 'in') : addPhoto(req, res);
    }

    /* ----- viewer endpoints (this computer only) ----- */
    if (!viewerOnly()) return;
    if (m === 'GET' && p === '/events') {
      sse(res); viewers.add(res);
      res.write('event: init\ndata: ' + JSON.stringify(photoList()) + '\n\n'); res.write('event: phones\ndata: ' + phonesSse.size + '\n\n');
      req.on('close', () => viewers.delete(res)); return;
    }
    if ((mm = /^\/photos\/(.+)$/.exec(p)) && PHOTO_RE.test(mm[1])) {
      const n = mm[1], f = D('photos/' + n);
      if (m === 'GET') { let b; try { b = Buffer.alloc(12); const fd = fs.openSync(f, 'r'); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd); } catch (e) { return deny(res, 404, 'Not found'); } return serveFile(req, res, f, null, MIME[sniff(b)] || 'image/jpeg'); }
      if (m === 'DELETE') { try { fs.renameSync(f, D('trash/' + n)); } catch (e) { return deny(res, 404, 'Not found'); } send(viewers, 'delete', n); return json(res, { ok: true }); }
    }
    if (m === 'POST' && p === '/restore') { const n = url.searchParams.get('name'); if (!PHOTO_RE.test(n || '') || !fs.existsSync(D('trash/' + n))) return deny(res, 404, 'Not found'); fs.renameSync(D('trash/' + n), D('photos/' + n)); send(viewers, 'restore', n); return json(res, { ok: true }); }
    if (m === 'POST' && p === '/replace') {
      const n = url.searchParams.get('name'); if (!PHOTO_RE.test(n || '') || !fs.existsSync(D('photos/' + n))) return deny(res, 404, 'Not found');
      try { await saveBody(req, D('photos/' + n), 60 * 1048576); } catch (e) { return deny(res, 413, 'Failed'); }
      ver[n] = Date.now(); ocrCache.forEach((v, k) => { if (k.startsWith(n + '|')) ocrCache.delete(k); }); send(viewers, 'update', { name: n, v: ver[n] }); return json(res, { ok: true });
    }
    if (m === 'GET' && p === '/ocr') {
      const n = url.searchParams.get('name') || '', lang = url.searchParams.get('lang') || 'eng';
      if (!PHOTO_RE.test(n) || !/^[a-z_]{3,12}(\+[a-z_]{3,12}){0,3}$/.test(lang)) return deny(res, 400, 'Bad request');
      const key = n + '|' + lang; if (!url.searchParams.get('force') && ocrCache.has(key)) return json(res, ocrCache.get(key));
      return tessLangs(avail => {
        if (!avail) return json(res, { text: '', error: 'Text reading is not installed on this computer (install Tesseract OCR).' });
        const want = lang.split('+'); let use = want.filter(l => avail.has(l));
        if (!use.length) use = avail.has('eng') ? ['eng'] : [...avail].filter(l => l !== 'osd').slice(0, 1);
        if (!use.length) return json(res, { text: '', error: 'No Tesseract language data is installed.' });
        const note = use.length < want.length ? 'Read as ' + use.join(' + ') + ' (the other language is not installed).' : '';
        execFile('tesseract', [D('photos/' + n), 'stdout', '-l', use.join('+')], { timeout: 90000, maxBuffer: 8 << 20 }, (err, out) => {
          if (err) return json(res, { text: '', error: 'Could not read the text.' });
          const r = { text: out.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim(), note }; ocrCache.set(key, r); json(res, r);
        });
      });
    }
    if (m === 'GET' && p === '/files') return json(res, { in: files.filter(f => f.dir === 'in').map(({ id, name, size }) => ({ id, name, size })), out: [] });
    if (m === 'GET' && (mm = /^\/in\/([\w-]+)$/.exec(p))) { const f = fileOf('in', mm[1]); if (!f) return deny(res, 404, 'Not found'); return serveFile(req, res, D('in/' + f.id), f.name, f.mime, url.searchParams.get('inline') === '1'); }
    if (m === 'DELETE' && (mm = /^\/files\/(in|out)\/([\w-]+)$/.exec(p))) {
      const f = fileOf(mm[1], mm[2]); if (!f) return deny(res, 404, 'Not found');
      files = files.filter(x => x !== f); writeJSON('files.json', files); fs.unlink(D(f.dir + '/' + f.id), () => {});
      send(viewers, 'filedel', { id: f.id, dir: f.dir }); return json(res, { ok: true });
    }
    if (m === 'GET' && p === '/api/status') { const l = photoList(); return json(res, { app: 'photo-mirror', photos: l.length, latest: l[l.length - 1] || null, files: files.filter(f => f.dir === 'in').length, phones: phonesSse.size }); }
    if (m === 'GET' && p === '/addr') return json(res, { host: lanIPs()[0] || 'localhost' });
    if (m === 'POST' && p === '/pair/new') {
      const raw = (url.searchParams.get('host') || '').trim(), host = raw || lanIPs()[0] || 'localhost';
      if (!/^[A-Za-z0-9.\-]{1,100}$/.test(host)) return deny(res, 400, 'Bad address');
      const code = crypto.randomBytes(6).toString('hex').slice(0, 10);
      for (const [k, v] of codes) if (v.exp < Date.now()) codes.delete(k);
      codes.set(code, { exp: Date.now() + 5 * 60e3 });
      return json(res, { url: 'http://' + host + ':' + ports.http + '/p/' + code, expires: 300 });
    }
    if (m === 'GET' && p === '/devices') return json(res, devices.map(({ id, name, made }) => ({ id, name, made })));
    if (m === 'DELETE' && (mm = /^\/devices\/([a-f0-9]{8})$/.exec(p))) { devices = devices.filter(d => d.id !== mm[1]); writeJSON('devices.json', devices); send(viewers, 'devices', ''); return json(res, { ok: true }); }
    if (m === 'POST' && p === '/devices/shortcut') {
      const token = crypto.randomBytes(24).toString('hex'); devices.push({ id: crypto.randomBytes(4).toString('hex'), name: 'Phone shortcut', made: Date.now(), token }); writeJSON('devices.json', devices);
      send(viewers, 'devices', ''); return json(res, { url: 'http://' + (lanIPs()[0] || 'localhost') + ':' + ports.http + '/s/' + token });
    }
    if (m === 'POST' && p === '/shutdown') {
      if (!allowShutdown) return deny(res, 403, 'Shutdown is disabled'); json(res, { ok: true });
      setTimeout(() => { api.close().then(() => { if (opts.onShutdown) opts.onShutdown(); else process.exit(0); }); }, 150); return;
    }
    deny(res, 404, 'Not found');
  }

  function listen(srv, start, host, tries) {
    return new Promise((resolve, reject) => {
      let port = start, left = tries;
      const go = () => { srv.once('error', e => { if (e.code === 'EADDRINUSE' && left-- > 0) { port++; go(); } else reject(e); }); srv.listen(port, host, () => { srv.removeAllListeners('error'); resolve(srv.address().port); }); };
      go();
    });
  }
  const api = {
    async start() {
      const host = opts.host || '0.0.0.0', want = +(opts.port || process.env.PM_PORT || 8080);
      const web = http.createServer((q, r) => handle(q, r, false).catch(e => { try { deny(r, 500, 'Server error'); } catch (x) {} console.error(e); }));
      web.requestTimeout = 0; web.headersTimeout = 30000;
      ports.http = await listen(web, want, host, 30); servers.push(web);
      if (opts.https !== false) {                              // secure link so the phone camera is allowed
        try {
          const ips = lanIPs(), f = D('cert.json'); let c = readJSON('cert.json', null);
          if (!c || c.ips !== ips.join(',') || Date.now() > c.exp) { c = Object.assign(makeCert(ips), { ips: ips.join(','), exp: Date.now() + 700 * 864e5 }); writeJSON('cert.json', c); }
          const sec = https.createServer({ key: c.key, cert: c.cert }, (q, r) => handle(q, r, true).catch(e => { try { deny(r, 500, 'Server error'); } catch (x) {} }));
          sec.requestTimeout = 0; ports.https = await listen(sec, ports.http + 1, host, 30); servers.push(sec);
        } catch (e) { ports.https = 0; console.error('Secure link unavailable:', e.message); }
      }
      return api;
    },
    close() { return Promise.all(servers.map(s => new Promise(r => { for (const c of [...viewers, ...phonesSse]) { try { c.end(); } catch (e) {} } s.close(() => r()); setTimeout(r, 500); }))); },
    get ports() { return ports; }, get dataDir() { return dataDir; }, lanIPs
  };
  return api;
}

module.exports = { create, makeCert, lanIPs };

if (require.main === module) {
  create().start().then(s => {
    const ip = lanIPs()[0];
    console.log('\n  Photo Mirror is running\n  On this computer:  http://localhost:' + s.ports.http + '/\n' + (ip ? '  Phone address:     http://' + ip + ':' + s.ports.http + '/phone  (scan the code in the app instead)\n' : '') + '  Data folder:       ' + s.dataDir + '\n  Press Ctrl+C to stop.\n');
    if (process.env.PM_OPEN === '1') {
      const url = 'http://localhost:' + s.ports.http + '/', cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch (e) {}
    }
  }).catch(e => { console.error('Could not start:', e.message); process.exit(1); });
}
