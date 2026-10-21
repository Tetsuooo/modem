// Read-only, gzip-compressed preview of the site's src/ for the app-browser tests
// (like GitHub Pages: the 12.9 MB archive goes out as ~1.8 MB). Static files + the SPA
// fallback, without server.js's /admin and save routes. Only on this PC (127.0.0.1).
// usage: node scripts/app-browser-tests/gz-preview.js   -> http://127.0.0.1:8087/radio-show
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const express = require(path.join(REPO, 'node_modules', 'express'));
const compression = require(path.join(REPO, 'node_modules', 'compression'));
const ROOT = path.join(REPO, 'src');
const PORT = 8087;
const app = express();
app.use(compression());
app.use(express.static(ROOT));
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.listen(PORT, '127.0.0.1', () => console.log('read-only gzip preview: http://127.0.0.1:' + PORT + '/radio-show'));
