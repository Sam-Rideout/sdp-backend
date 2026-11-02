'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createProfileAvailability,
  SCHEMA,
  MAX_AGE_MS
} = require('../profile-availability');

test('availability reports require exact certified identity and freshness', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'px-availability-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));

  const store = createProfileAvailability(dir);

  const profile = {
    status:'READY',
    owner_member_id:'member-one',
    voice_profile_id:'PXPITCH-Test',
    voice_model_id:'TestModel',
    model_sha256:'a'.repeat(64),
    index_sha256:'b'.repeat(64),
    certification_id:'PXCERT-Test',
    certification_sha256:'c'.repeat(64)
  };

  const report = {
    schema_version:SCHEMA,
    owner_member_id:profile.owner_member_id,
    voice_profile_id:profile.voice_profile_id,
    voice_model_id:profile.voice_model_id,
    model_sha256:profile.model_sha256,
    index_sha256:profile.index_sha256,
    certification_id:profile.certification_id,
    certification_sha256:profile.certification_sha256,
    available:true,
    checked_at:new Date().toISOString()
  };

  assert.equal(await store.available(profile), false);

  await store.publish(profile, report);
  assert.equal(await store.available(profile), true);

  assert.equal(await store.available({
    ...profile, model_sha256:'d'.repeat(64)
  }), false);

  assert.equal(await store.available({
    ...profile, owner_member_id:'member-two'
  }), false);

  await assert.rejects(
    store.publish(profile, {...report, index_sha256:'e'.repeat(64)}),
    /does not match certified profile/
  );

  await store.publish(profile, {...report, available:false});
  assert.equal(await store.available(profile), false);

  assert.equal(MAX_AGE_MS, 300000);

  // An old report must never authorize another song.
  await store.publish(profile, {...report, available:true});

  const crypto = require('node:crypto');
  const reportPath = path.join(
    dir,
    'profile-availability',
    crypto.createHash('sha256')
      .update(profile.voice_profile_id).digest('hex') + '.json'
  );

  const expired = {
    ...report,
    checked_at:new Date(Date.now() - MAX_AGE_MS - 1000).toISOString()
  };

  await fs.writeFile(reportPath, JSON.stringify(expired));

  assert.equal(
    await store.available(profile),
    false,
    'expired availability reports are rejected'
  );
});
