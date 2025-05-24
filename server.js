const express = require('express');
const path = require('path');
const app = express();

// Serve static assets from src
app.use(express.static(path.join(__dirname, 'src')));

// For all routes, serve index.html to enable client-side routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'index.html'));
});

const port = 8085;
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
