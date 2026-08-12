const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// index.html must never be cached — teams kept seeing stale UI after deploys
const noCache = (res) => res.setHeader('Cache-Control', 'no-cache, must-revalidate');
app.use(express.static(path.join(__dirname), {
  setHeaders: (res, filePath) => { if (filePath.endsWith('.html')) noCache(res); },
}));

app.get('*', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log('HP Tracker running on port ' + PORT);
});
