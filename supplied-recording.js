'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const MAX_BYTES=64*1024*1024;
function wavInfo(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length<44||bytes.length>MAX_BYTES||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||bytes.readUInt32LE(4)!==bytes.length-8) throw new Error('Use a complete PCM WAV file, no larger than 64 MiB.');
  let format=null,data=null;
  for(let offset=12;offset<bytes.length;){
    if(offset+8>bytes.length)throw new Error('Incomplete WAV chunk.');
    const id=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8,end=start+size;
    if(end>bytes.length)throw new Error('WAV chunk exceeds file length.');
    if(id==='fmt '){if(format||size<16)throw new Error('Invalid WAV format chunk.');format={encoding:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),rate:bytes.readUInt32LE(start+4),byteRate:bytes.readUInt32LE(start+8),align:bytes.readUInt16LE(start+12),bits:bytes.readUInt16LE(start+14)};}
    if(id==='data'){if(data!==null)throw new Error('Duplicate WAV data chunk.');data=size;}
    offset=end+(size%2);if(offset>bytes.length)throw new Error('Incomplete WAV padding.');
  }
  if(!format||format.encoding!==1||![1,2].includes(format.channels)||![16,24,32].includes(format.bits)||format.rate<16000||format.rate>96000||format.align!==format.channels*format.bits/8||format.byteRate!==format.rate*format.align||!data||data%format.align)throw new Error('Use uncompressed 16, 24 or 32 bit PCM WAV, mono or stereo.');
  const seconds=data/format.byteRate;
  if(seconds<1||seconds>1800)throw new Error('Recording must be between one second and 30 minutes.');
  return {duration_seconds:seconds,sample_rate:format.rate,channels:format.channels};
}
function attachSuppliedRecording(app,c){
  const route=fn=>async(req,res,next)=>{try{await fn(req,res,next);}catch(e){if(e.code==='ENOENT')return res.status(404).json({error:'Session not found.'});next(e);}};
  function enabled(req,res,next){if(c.config().supplied_recordings_enabled!==true)return res.status(403).json({error:'Supplied recordings are not enabled.'});next();}
  async function upload(req,res){
    if(!req.memberId&&!c.lockSessionRequest(req,res))return;
    const m=await c.readManifest(req.params.sessionId);
    if(m.program!=='CUSTOMER'||m.training_source!=='SUPPLIED_RECORDING'||m.status!=='RECORDING')return res.status(409).json({error:'An open supplied-recording customer session is required.'});
    // A customer can upload only to their own session. The protected operator
    // route requires an explicit expected owner as an additional identity check.
    const owner=req.memberId||req.get('X-PX-Expected-Owner');
    if(owner!==m.owner_member_id)return res.status(404).json({error:'Session not found.'});
    if(Object.values(m.sections||{}).some(s=>(s.takes||[]).length))return res.status(409).json({error:'A source is already saved. Use a new session to replace it.'});
    let info;try{info=wavInfo(req.body);}catch(e){return res.status(400).json({error:e.message});}
    if(await c.directoryBytes(c.dataDir)+req.body.length>c.maxStoreBytes)return res.status(507).json({error:'Recording storage is full.'});
    const sha=crypto.createHash('sha256').update(req.body).digest('hex'),relative='clips/supplied/Source.wav',target=path.join(c.sessionPath(m.session_id),relative);
    await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
    await fs.writeFile(target,req.body,{flag:'wx',mode:0o600});
    m.sections['1'].takes=[{clip_id:crypto.randomUUID(),section:1,take:1,purpose:'SUPPLIED_TRAINING_RECORDING',excluded_from_training:false,file_name:'Source.wav',relative_path:relative,mime_type:'audio/wav',duration_seconds:info.duration_seconds,bytes:req.body.length,sha256:sha,created_at:new Date().toISOString()}];
    m.updated_at=new Date().toISOString();await c.writeManifest(m);
    res.json({ok:true,source_sha256:sha,session:c.publicManifest(m)});
  }
  app.post('/api/sessions/:sessionId/supplied-recording',c.authenticatedMember,c.requireSameOrigin,c.requireCaptureAccess,c.ownedManifest,enabled,c.express.raw({type:['audio/wav','audio/x-wav'],limit:MAX_BYTES}),route(upload));
  app.post('/api/transfer/sessions/:sessionId/supplied-recording',c.transferAuth,enabled,(req,res,next)=>c.safeSessionId(req.params.sessionId)?next():res.status(404).json({error:'Session not found.'}),c.express.raw({type:['audio/wav','audio/x-wav'],limit:MAX_BYTES}),route(upload));
  app.post('/api/sessions/:sessionId/complete',c.authenticatedMember,c.requireCaptureAccess,route(async(req,res,next)=>{if(!c.safeSessionId(req.params.sessionId))return next('route');const m=await c.readManifest(req.params.sessionId);return m.training_source==='SUPPLIED_RECORDING'?next():next('route');}),c.authenticatedMember,c.requireSameOrigin,c.requireCaptureAccess,c.ownedManifest,route(async(req,res,next)=>{
    if(req.manifest.training_source!=='SUPPLIED_RECORDING')return next();
    if(c.config().supplied_recordings_enabled!==true)return res.status(403).json({error:'Supplied recordings are not enabled.'});
    const m=await c.readManifest(req.params.sessionId),clip=m.sections?.['1']?.takes?.[0];
    if(m.status!=='RECORDING'||!clip||req.body?.source_sha256!==clip.sha256||req.body?.approve_supplied_recording!==true||req.body?.start_training!==true)return res.status(400).json({error:'Listen to the exact saved recording and approve it before training.'});
    // This approval can be made only by the authenticated owner; a protected
    // operator upload never authorizes the recording on the customer's behalf.
    m.supplied_recording_approval={accepted:true,member_id:req.memberId,session_id:m.session_id,source_sha256:clip.sha256,consent_version:m.consent.version,accepted_at:new Date().toISOString()};
    try{require('./voice-phone-flow').approvePhoneFinish(m,req.body,req.memberId,req.get('User-Agent')||'');}catch(e){return res.status(400).json({error:e.message});}
    m.status='READY_FOR_TRANSFER';m.completed_at=new Date().toISOString();m.updated_at=m.completed_at;await c.writeManifest(m);
    res.json({session:c.publicManifest(m)});
  }));
}
module.exports={attachSuppliedRecording,wavInfo,MAX_BYTES};
