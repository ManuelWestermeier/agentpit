import express from 'express';
import { MEDIA_NAME_RE } from './media.js';

/**
 * Media files and the web UI. Always `sendFile(name, { root })`: with an absolute path `send` checks every
 * folder of it for a leading dot and answers 404 – and npx installs to ~/.npm/_npx/…, data lives in
 * ~/.agentpit. With `root` only the part below root is checked, so real dotfiles there (.env) stay hidden.
 */
export function mountStatic(app, { webDist, mediaDir, hasUi }) {
  app.get('/media/:name', (req, res) => {
    if (!MEDIA_NAME_RE.test(req.params.name)) return res.status(404).end();
    res.sendFile(req.params.name, { root: mediaDir, maxAge: '30d', immutable: true });
  });
  if (!hasUi) return false;
  app.use(express.static(webDist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/|media\/).*/, (_req, res) => res.sendFile('index.html', { root: webDist }));
  return true;
}
