'use strict';

const {createProfileAvailability} = require('./profile-availability');

function attachProfileAvailability(app, context) {
  const {dataDir, transferAuth, profiles} = context;
  const availability = createProfileAvailability(dataDir);

  app.post('/api/transfer/profile-availability',
    transferAuth,
    async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');

        const report = req.body;

        if (!report || typeof report.owner_member_id !== 'string' ||
            report.owner_member_id.length < 3 ||
            report.owner_member_id.length > 200 ||
            typeof report.voice_profile_id !== 'string' ||
            !report.voice_profile_id) {
          return res.status(400).json({
            error:'Invalid availability report.'
          });
        }

        const owned = await profiles(report.owner_member_id);
        const matches = owned.filter(x =>
          x.record.status === 'READY' &&
          x.record.voice_profile_id === report.voice_profile_id
        );

        if (matches.length !== 1) {
          return res.status(404).json({
            error:'Certified customer profile not found.'
          });
        }

        const profile = matches[0].record;

        await availability.publish(profile, report);

        res.json({
          ok:true,
          voice_profile_id:profile.voice_profile_id,
          available:await availability.available(profile)
        });
      } catch (error) {
        if (error.message ===
            'Availability report does not match certified profile.' ||
            error.message === 'Invalid availability status.' ||
            error.message === 'Availability timestamp is invalid.') {
          return res.status(400).json({error:error.message});
        }
        next(error);
      }
    });

  return availability;
}

module.exports = {attachProfileAvailability};
