'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {attachProfileAvailability} = require('../profile-availability-route');
const {SCHEMA} = require('../profile-availability');

test('availability route enforces authentication and certified identity', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'px-availability-route-'));
  t.after(() => fs.rm(dataDir, {recursive:true, force:true}));

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

  const routes = new Map();
  const app = {post:(url,...handlers) => routes.set(url,handlers)};

  const availability = attachProfileAvailability(app,{
    dataDir,
    transferAuth:(req,res,next) => {
      if (req.authorized !== true) {
        res.status(401).json({error:'Transfer authorization failed.'});
        return;
      }
      next();
    },
    profiles:async member => member === 'member-one'
      ? [{record:profile}]
      : []
  });

  async function call(body, authorized=false) {
    const handlers = routes.get('/api/transfer/profile-availability');
    assert.ok(handlers);
    const result = {status:200};
    const res = {
      status(n){result.status=n;return this;},
      set(){return this;},
      json(value){result.body=value;return this;}
    };
    const req = {body,authorized};
    async function run(i) {
      if (i >= handlers.length) return;
      let following;
      await handlers[i](req,res,error=>{
        following = error ? Promise.reject(error) : run(i+1);
      });
      if (following) await following;
    }
    await run(0);
    return result;
  }

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

  assert.equal((await call(report)).status,401);
  assert.equal(await availability.available(profile),false);

  assert.equal((await call({...report,owner_member_id:'member-two'},true)).status,404);
  assert.equal((await call({...report,index_sha256:'d'.repeat(64)},true)).status,400);

  const accepted = await call(report,true);
  assert.equal(accepted.status,200);
  assert.equal(accepted.body.ok,true);
  assert.equal(await availability.available(profile),true);
});
