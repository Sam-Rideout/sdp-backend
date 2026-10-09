#!/usr/bin/env python3
"""Account-test pickup and orchestration. Executive Office remains the sole trainer launcher."""
import argparse, getpass, hashlib, importlib.util, json, os, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path
from contextlib import closing
import auto_transfer_voice_sessions as pickup
import transfer_voice_session as transfer

EXPECTED_MEMBER='29b28efa-5b13-4799-a369-6348c59c0f5e'
CUSTOMER_ID='PXC-000003'

def digest(value): return hashlib.sha256(value).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def load(path):return json.loads(Path(path).read_text(encoding='utf-8-sig'))

def verify_finish(envelope):
    manifest=envelope['manifest'];sid=manifest['session_id'];request=manifest.get('phone_training',{})
    if (envelope.get('profile_id')!=EXPECTED_MEMBER or manifest.get('program')!='CUSTOMER' or manifest.get('status')!='TRANSFERRED_AUDIO_DELETED' or request.get('accepted') is not True or request.get('member_id')!=EXPECTED_MEMBER or request.get('session_id')!=sid or request.get('consent_version')!=manifest['consent']['version'] or manifest['consent'].get('adult_confirmed') is not True or manifest['consent'].get('own_voice_confirmed') is not True):
        raise RuntimeError('Capture is not this account\'s phone-authorized customer training session.')
    rows=[dict(clip_id=c['clip_id'],section=c['section'],take=c['take'],sha256=c['sha256']) for section in manifest['sections'].values() for c in section.get('takes',[]) if 1<=c['section']<=8 and c.get('excluded_from_training') is not True]
    rows.sort(key=lambda c:c['clip_id'])
    # Node JSON.stringify records these fields in this exact order.
    row_hash=digest(json.dumps(rows,separators=(',',':'),ensure_ascii=False).encode())
    if request.get('source_clips')!=rows or request.get('source_clips_sha256')!=row_hash or len({r['clip_id'] for r in rows})!=len(rows) or any(not any(r['section']==s for r in rows) for s in range(1,9)):
        raise RuntimeError('Phone-approved capture clip evidence changed.')
    return sid

class Api:
    def __init__(self,url,token):
        from urllib.parse import urlsplit
        parsed=urlsplit(url)
        if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('','/'):
            raise RuntimeError('Use an HTTPS origin for the phone bridge.')
        self.url=url.rstrip('/');self.token=token
    def json(self,path,method='GET',payload=None):
        # Disallow cross-host redirects before credentials can be sent.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):return None
        data=None if payload is None else canonical(payload)
        headers={'Authorization':'Bearer '+self.token,'Accept':'application/json'}
        if data is not None:headers['Content-Type']='application/json'
        req=urllib.request.Request(self.url+path,data=data,method=method,headers=headers)
        with urllib.request.build_opener(NoRedirect).open(req,timeout=30) as res:return json.loads(res.read(2_000_001))
    def audio(self,sid,sha,data):
        if len(data)>2*1024*1024 or digest(data)!=sha:raise RuntimeError('Preview is too large or changed.')
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):return None
        req=urllib.request.Request(self.url+f'/api/transfer/sessions/{sid}/phone-audio/{sha}',data=data,method='PUT',headers={'Authorization':'Bearer '+self.token,'Content-Type':'audio/mpeg'})
        with urllib.request.build_opener(NoRedirect).open(req,timeout=30) as res:return json.loads(res.read())

def exact_request(root,record):
    matches=[]
    for path in (root/'Jobs/Training_Intake').glob('PXTR_*/Training_Request.json'):
        try:r=load(path)
        except (FileNotFoundError,json.JSONDecodeError):continue
        inputs=r.get('customer_inputs',{})
        if inputs.get('consent_authorization_reference')==record['authorization_reference']:
            if inputs.get('new_voice_model_id')!=record['model_id'] or Path(inputs.get('approved_training_recording','')).resolve()!=Path(record['source_recording']).resolve():raise RuntimeError('Training request belongs to different enrolled evidence.')
            matches.append(path)
    if len(matches)>1:raise RuntimeError('Multiple training requests claim one enrollment.')
    return matches[0] if matches else None

def portal_module(root):
    path=root/'Modules/PXM-019/key_bracket_portal.py'
    spec=importlib.util.spec_from_file_location('px_phone_governed_portal',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

class KeyRelay:
    def __init__(self,root,api,sid,record,job_id):
        self.root=root;self.api=api;self.sid=sid;self.record=record;self.job_id=job_id;self.uploaded=set();self.portal=portal_module(root);self.request_path=None;self.state=None
    def request(self):
        if self.request_path:return self.request_path
        path=exact_request(self.root,self.record)
        if path:
            self.request_path=path;self.state=self.portal.PortalState(path)
        return path
    def packet(self):
        if not self.request():return None
        package=self.state.package();progress=self.state.progress();selection=self.state.selection()
        common={'job_id':self.job_id,'model_id':self.record['model_id'],'enrollment_id':self.record['enrollment_id'],'request_id':self.state.request['request_id'],'epoch':int(progress.get('latest_epoch',0) or 0),'selected_shift':selection.get('selected_semitone_shift') if selection else None}
        if selection:return {**common,'phase':'TRAINING','package_id':'','options':[]}
        if package.get('status')!='READY':return {**common,'phase':'TRAINING','package_id':'','options':[]}
        if package.get('model_id')!=self.record['model_id']:raise RuntimeError('Key Finder package model identity mismatch.')
        session=self.state.session(package)
        package_id=digest(canonical({'request_id':common['request_id'],'package':package,'session':session}))
        options=[]
        for shift in session['bracket']:
            item=package['shift_cache'][str(shift)];audio=Path(item['mp3']).resolve()
            if not any(audio.is_relative_to((self.root/p).resolve()) for p in ('Reports/PXM-019','Jobs/Training_Intake')) or any(part.lower() in ('g_backups','pxd-001') for part in audio.parts):raise RuntimeError('Preview path is outside the owned training workspaces.')
            data=audio.read_bytes();sha=digest(data)
            if sha not in self.uploaded:self.api.audio(self.sid,sha,data);self.uploaded.add(sha)
            options.append({'shift':int(shift),'sha256':sha,'label':self.portal.label_for_shift(int(shift)),'key':str(item.get('resulting_key','')),'suggested':item.get('recommended') is True or int(shift)==package.get('recommended_vocal_shift')})
        return {**common,'phase':'KEY_SELECTION','package_id':package_id,'round':session['round'],'options':options}
    def tick(self):
        packet=self.packet()
        if packet is None:return
        remote=self.api.json(f'/api/transfer/sessions/{self.sid}/phone-flow')['state']
        command=remote.get('command') if remote else None
        if command and command.get('applied') is not True:
            # A restart after a local write but before remote ACK reuses sealed command evidence.
            receipt=self.request_path.parent/'Phone_Command_Receipt.json'
            prior=load(receipt) if receipt.is_file() else {}
            if prior.get('command_id')!=command['command_id']:
                if command.get('package_id')!=packet.get('package_id') or command.get('shift') not in [o['shift'] for o in packet.get('options',[])]:raise RuntimeError('Phone command references stale Key Finder evidence.')
                package=self.state.package();session=self.state.session(package)
                action,updated=self.portal.next_selection_action(command['shift'],session,package)
                # Record intent before writes. Ambiguous interrupted application requires review, not a guessed repeat.
                pending=self.request_path.parent/'Phone_Command_Pending.json'
                if pending.is_file():raise RuntimeError('A prior phone key application requires review.')
                self.portal.write_json(pending,command)
                self.portal.write_json(self.state.session_path,updated)
                if action=='FINALIZE':self.state.finalize(command['shift'],updated,package)
                self.portal.write_json(receipt,{'command_id':command['command_id'],'package_id':command['package_id'],'applied':True})
                pending.unlink()
            self.api.json(f'/api/transfer/sessions/{self.sid}/phone-command/ack','POST',{'job_id':self.job_id,'command_id':command['command_id']})
            packet=self.packet()
        self.api.json(f'/api/transfer/sessions/{self.sid}/phone-flow','PUT',packet)

class Sequence:
    def __init__(self,root,api,state_dir):
        self.root=root;self.api=api;self.state_dir=state_dir
        sys.path.insert(0,str(root/'Services/PX_Admin'))
        import px_wix_customer_link as links,px_customer_training_intake as intake,px_voice_certification_handoff as cert
        self.links=links;self.intake=intake;self.cert=cert;self.db=root/'Data/PX_Admin/PX_Admin.sqlite3'
    def push(self,sid,record,job_id,phase):
        return self.api.json(f'/api/transfer/sessions/{sid}/phone-flow','PUT',{'job_id':job_id,'model_id':record['model_id'],'enrollment_id':record['enrollment_id'],'phase':phase,'options':[]})
    def fail_before_launch(self,sid):
        state_path=self.state_dir/(sid+'.json')
        if state_path.exists():return
        record={'model_id':'RVC_Train_Sam_Rideout_Tier_01_Epoch_300_Phone_'+sid.replace('-','')[:12],'enrollment_id':'NOT_ENROLLED'}
        job_id='PXPHONE-'+sid.replace('-','')
        self.push(sid,record,job_id,'REVIEW_REQUIRED')
        pickup.atomic_json(state_path,{'phase':'REVIEW_REQUIRED','job_id':job_id,'record':record})
    def process(self,sid):
        if not pickup.UUID.fullmatch(sid):raise RuntimeError('Invalid phone session ID.')
        state_path=self.state_dir/(sid+'.json')
        existing=load(state_path) if state_path.exists() else None
        if existing:
            if existing['phase']=='READY_PENDING_PHONE':
                self.push(sid,existing['record'],existing['job_id'],'READY')
                existing['phase']='READY';pickup.atomic_json(state_path,existing);return
            if existing['phase'] in ('READY','FAILED','REVIEW_REQUIRED'):return
            # Never re-launch a claimed training job after an ambiguous interruption.
            self.push(sid,existing['record'],existing['job_id'],'REVIEW_REQUIRED')
            existing['phase']='REVIEW_REQUIRED';pickup.atomic_json(state_path,existing);return
        envelope=self.links.fetch_session(self.api.url,sid,self.api.token);verify_finish(envelope)
        self.links.bind(self.db,envelope,sid,CUSTOMER_ID)
        folder=self.root/'Voices'/EXPECTED_MEMBER/sid
        draft_path=folder/'Training_Intake/Training_Intake_Draft.json'
        model='RVC_Train_Sam_Rideout_Tier_01_Epoch_300_Phone_'+sid.replace('-','')[:12]
        registry=self.cert.load(self.root/'Modules/PXM-011/Voice_Model_Registry.json')
        if any(r.get('model_id')==model for r in registry.get('models',[])):raise RuntimeError('Phone-test model is already registered.')
        with closing(self.links.connect(self.db)) as con:
            enrolled=con.execute('SELECT enrollment_json FROM voice_training_enrollments WHERE session_id=?',(sid,)).fetchall()
        if len(enrolled)>1:raise RuntimeError('Multiple enrollments claim one phone session.')
        if enrolled:record=json.loads(enrolled[0][0])
        else:
            if not draft_path.exists():
                ffmpeg=self.cert.load(self.root/'Config/PX_Config.json')['ffmpeg']
                draft_path=self.intake.prepare(self.root,self.db,envelope,sid,CUSTOMER_ID,model,'Sam Rideout',ffmpeg)
            # Finish approved the exact saved source clips. All normal intake integrity checks remain.
            record=self.intake.approve(self.db,draft_path,envelope)
        if record['model_id']!=model or record['wix_member_id']!=EXPECTED_MEMBER:raise RuntimeError('Phone enrollment identity mismatch.')
        job_id='PXPHONE-'+sid.replace('-','');local={'phase':'CLAIMED','job_id':job_id,'record':record,'phone_test_context':envelope['manifest']['phone_training'].get('test_context',{}),'phone_approved_clips_sha256':envelope['manifest']['phone_training']['source_clips_sha256']}
        pickup.atomic_json(state_path,local)
        try:
            self.push(sid,record,job_id,'PREPARING')
            env=os.environ.copy();env['VOICE_TRANSFER_TOKEN']=self.api.token;env['PX_PHONE_TRAINING_ENROLLMENT']=record['enrollment_id']
            log_path=folder/'Phone_Executive_Console.log'
            with log_path.open('w',encoding='utf-8') as log:
                proc=subprocess.Popen([sys.executable,str(self.root/'Modules/PXM-000/pxm000_executive_office.py'),'--customer-training-enrollment',record['enrollment_id'],'--publish-ready','--url',self.api.url],cwd=str(self.root),env=env,stdout=log,stderr=subprocess.STDOUT)
                local.update(phase='RUNNING',executive_process_id=proc.pid);pickup.atomic_json(state_path,local)
                relay=KeyRelay(self.root,self.api,sid,record,job_id)
                while proc.poll() is None:
                    try:relay.tick()
                    except (urllib.error.URLError,TimeoutError,json.JSONDecodeError,OSError) as error:
                        print('PHONE STATUS: connection/data update pending; processing continues.',flush=True)
                    time.sleep(3)
                code=proc.wait()
            if code!=0:raise RuntimeError('Executive Office training or certification did not succeed. See local run log.')
            # Read Executive's terminal result; never mark READY from a browser decision or epoch count.
            results=[json.loads(line.split('=',1)[1]) for line in log_path.read_text(encoding='utf-8',errors='replace').splitlines() if line.startswith('CUSTOMER_TRAINING_RESULT=')]
            if len(results)!=1 or results[0].get('status')!='READY' or results[0].get('session_id')!=sid or results[0].get('enrollment_id')!=record['enrollment_id'] or results[0].get('model_id')!=record['model_id']:raise RuntimeError('Exact Executive certification result is missing.')
            local.update(phase='READY_PENDING_PHONE',result=results[0]);pickup.atomic_json(state_path,local)
            self.push(sid,record,job_id,'READY');local.update(phase='READY');pickup.atomic_json(state_path,local)
            print(f'PHONE SEQUENCE READY: {sid}',flush=True)
        except BaseException:
            if local['phase']=='READY_PENDING_PHONE':
                print('Certified READY result saved; phone notification will retry without retraining.',flush=True)
                return
            local['phase']='REVIEW_REQUIRED';pickup.atomic_json(state_path,local)
            try:self.push(sid,record,job_id,'REVIEW_REQUIRED')
            except Exception:pass
            raise

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--url',default='https://sdp-backend-6xt7.onrender.com');parser.add_argument('--engine',type=Path,default=Path('D:/Working/Project_X/PX_Engine'));args=parser.parse_args()
    root=args.engine.resolve();token=os.environ.get('VOICE_TRANSFER_TOKEN') or getpass.getpass('Render transfer token (once for phone worker): ')
    if len(token.encode())<32:raise RuntimeError('Transfer token must be at least 32 characters.')
    api=Api(args.url,token);state_dir=root/'Data/Phone_Sequence';state_dir.mkdir(parents=True,exist_ok=True)
    pickup_dir=root/'Data/Voice_Transfer_Pickup';pickup_dir.mkdir(parents=True,exist_ok=True)
    # The original pickup lock prevents two workers from racing the same transfer.
    with pickup.WorkerLock(pickup_dir/'Pickup.lock'):
        worker=pickup.PickupWorker(args.url,root/'Voices',pickup_dir,token);sequence=Sequence(root,api,state_dir)
        print('PHONE SEQUENCE ACTIVE: automatic pickup, Executive training, phone Key Finder and certification. Ctrl+C stops this worker.',flush=True)
        while True:
            try:
                worker.scan()
                for row in api.json('/api/transfer/phone-jobs')['sessions']:
                    sid=row['session_id']
                    try:sequence.process(sid)
                    except Exception as error:
                        if not pickup.UUID.fullmatch(sid):raise
                        print(f'PHONE TEST NEEDS REVIEW: {sid} | {error}',flush=True)
                        sequence.fail_before_launch(sid)
            except Exception as error:print(f'PHONE SEQUENCE CHECK: {error}',flush=True)
            time.sleep(10)
if __name__=='__main__':
    try:main()
    except KeyboardInterrupt:print('\nPhone sequence worker stopped. Review any active training before restarting.')
