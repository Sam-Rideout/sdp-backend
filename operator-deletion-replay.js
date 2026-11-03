'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createReplayGuard(dataDir) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw new Error('Absolute protected data directory required.');
  }

  const directory = path.join(dataDir, 'operator-deletion-nonces');

  async function consume(nonce) {
    if (typeof nonce !== 'string' ||
        !/^[a-f0-9]{48}$/.test(nonce)) {
      const error = new Error('Invalid operator authorization nonce.');
      error.status = 403;
      throw error;
    }

    await fs.mkdir(directory, {
      recursive: true,
      mode: 0o700
    });

    const name = crypto.createHash('sha256')
      .update(nonce)
      .digest('hex') + '.used';

    const filename = path.join(directory, name);

    let file;

    try {
      file = await fs.open(filename, 'wx', 0o600);
      await file.writeFile('CONSUMED\n');
      await file.sync();
    } catch (error) {
      if (error.code === 'EEXIST') {
        const denied = new Error(
          'Operator authorization has already been used.'
        );
        denied.status = 409;
        throw denied;
      }

      throw error;
    } finally {
      if (file) await file.close();
    }

    return true;
  }

  return {consume};
}

module.exports = {createReplayGuard};
