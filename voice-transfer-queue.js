'use strict';
const fs = require('node:fs/promises');
function attachTransferQueue(app, { sessionDir, readManifest, safeSessionId, transferAuth }) {
  app.get('/api/transfer/ready-sessions', transferAuth, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const after = String(req.query?.after || '');
      if (after && !safeSessionId(after)) return res.status(400).json({error:'Invalid queue cursor.'});
      const entries = await fs.readdir(sessionDir, {withFileTypes:true});
      const ids = entries.filter(entry => entry.isDirectory() && safeSessionId(entry.name) && entry.name > after)
        .map(entry => entry.name).sort();
      const sessions = []; let cursor = null;
      for (const id of ids) {
        let manifest;
        try { manifest = await readManifest(id); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (manifest.session_id !== id) throw new Error('Session directory identity mismatch.');
        if (manifest.status === 'READY_FOR_TRANSFER') sessions.push({session_id:id});
        if (sessions.length === 100) { cursor = id; break; }
      }
      res.json({sessions, next_cursor:cursor});
    } catch (error) { next(error); }
  });
}
module.exports = {attachTransferQueue};
