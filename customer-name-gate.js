'use strict';

// A name is account metadata, never consent or permission to train.
function complete(identity) {
  return !!identity && ['first_name', 'last_name'].every(key =>
    typeof identity[key] === 'string' && identity[key] === identity[key].trim() &&
    identity[key].length > 0 && identity[key].length <= 100 &&
    !/[\u0000-\u001f\u007f]/.test(identity[key]));
}

function requireNewCaptureNames(store) {
  return async (req, res, next) => {
    try {
      if (req.captureProgram !== 'CUSTOMER') return next();
      const identity = await store.forTransfer(req.memberId);
      if (!identity || identity.member_id !== req.memberId || identity.email !== req.memberEmail) {
        return res.status(403).json({error:'Reopen voice capture from your signed-in Wix account to confirm your account details.'});
      }
      if (!complete(identity)) return res.status(409).json({
        code:'CUSTOMER_NAME_REQUIRED',
        error:'Please save your first and last names before starting a new voice recording.',
        profileUrl:'https://www.sdpsongs.ca/complete-profile'
      });
      next();
    } catch (error) { next(error); }
  };
}

function attachIdentityRead(app, transferAuth, store) {
  app.get('/api/transfer/customers/:memberId/identity', transferAuth, async (req,res,next) => {
    try {
      if (!/^[A-Za-z0-9_-]{3,200}$/.test(req.params.memberId || '')) return res.status(400).json({error:'Invalid member ID.'});
      const identity = await store.forTransfer(req.params.memberId);
      res.set('Cache-Control','no-store');
      if (!identity || !complete(identity)) return res.status(409).json({error:'This member must save their names and open voice capture from Wix first.'});
      if (identity.member_id !== req.params.memberId) throw new Error('Identity owner differs.');
      res.json({customer_identity:identity});
    } catch(error) { next(error); }
  });
}

module.exports = {complete, requireNewCaptureNames, attachIdentityRead};
