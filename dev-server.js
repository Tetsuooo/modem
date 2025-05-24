const express = require('express');
const path = require('path');

const app = express();
const port = 8080;

// Serve static files from dist
app.use(express.static(path.join(__dirname, 'dist')));

// Serve assets directly from src/assets for development
app.use('/assets', express.static(path.join(__dirname, 'src/assets')));

// Handle SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist/index.html'));
});

app.listen(port, () => {
  console.log(`Dev server running at http://localhost:${port}`);
});
