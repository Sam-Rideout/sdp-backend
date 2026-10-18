#!/usr/bin/env python3
"""Linked-customer pickup and orchestration. Executive Office remains the sole trainer launcher."""
import argparse, getpass, hashlib, importlib.util, json, os, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path
from datetime import datetime, timezone
from contextlib import closing
import auto_transfer_voice_sessions as pickup
import transfer_voice_session as transfer

# Runtime health is observational; Executive Office remains the only launcher.
RUNTIME = None

def note(event,error=None,code='NETWORK_RETRY',sid=''):
    if RUNTIME is not None:RUNTIME.message(event,error,code,sid)
    else:
        from px_capture_runtime import safe_error
        print(event+(': '+safe_error(error) if error else ''),flush=True)


def digest(value): return hashlib.sha256(value).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def load(path):return json.loads(Path(path).read_text(encoding='utf-8-sig'))

def verify_finish(envelope):
    manifest=envelope['manifest'];sid=manifest['session_id'];request=manifest.get('phone_training',{})
    if (not isinstance(envelope.get('profile_id'),str) or manifest.get('program')!='CUSTOMER' or manifest.get('status')!='TRANSFERRED_AUDIO_DELETED' or request.get('accepted') is not True or request.get('member_id')!=envelope.get('profile_id') or request.get('session_id')!=sid or request.get('consent_version')!=manifest['consent']['version'] or manifest['consent'].get('adult_confirmed') is not True or manifest['consent'].get('own_voice_confirmed') is not True):
        raise RuntimeError('Capture is not this account\'s phone-authorized customer training session.')
    rows=[dict(clip_id=c['clip_id'],section=c['section'],take=c['take'],sha256=c['sha256']) for section in manifest['sections'].values() for c in section.get('takes',[]) if 1<=c['section']<=8 and c.get('excluded_from_training') is not True]
    rows.sort(key=lambda c:c['clip_id'])
    # Node JSON.stringify records these fields in this exact order.
    row_hash=digest(json.dumps(rows,separators=(',',':'),ensure_ascii=False).encode())
    if request.get('source_clips')!=rows or request.get('source_clips_sha256')!=row_hash or len({r['clip_id'] for r in rows})!=len(rows) or (manifest.get('training_source')!='SUPPLIED_RECORDING' and any(not any(r['section']==s for r in rows) for s in range(1,9))):
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

def public_training_stage(progress):
    stage = str(progress.get('stage', '')).casefold()
    if 'error' in stage: return 'REVIEW_REQUIRED'
    if ('q10' in stage or 'q20' in stage) and 'quality gate' in stage: return 'CALIBRATING'
    if 'pipeline complete' in stage or 'verification' in stage or 'registration' in stage or 'quality gate' in stage: return 'VERIFYING'
    if 'preview' in stage or 'bracket' in stage: return 'PREPARING_PREVIEWS'
    if 'index' in stage: return 'BUILDING_INDEX'
    if 'calibration training' in stage or 'calibration fallback' in stage: return 'CALIBRATING'
    if 'training' in stage: return 'TRAINING'
    if 'pitch' in stage or 'feature extraction' in stage: return 'ANALYZING_VOICE'
    return 'CHECKING_RECORDINGS'


def public_progress_time(progress):
    raw = progress.get('heartbeat')
    if not isinstance(raw, str): return None
    try:
        # Native PXM-019 heartbeats are local naive timestamps on this PC.
        # astimezone uses the producer's local zone before publishing UTC.
        return datetime.fromisoformat(raw.replace('Z', '+00:00')).astimezone(timezone.utc).isoformat()
    except ValueError:
        return None


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
        import px_automatic_voice_key as automatic
        progress=self.state.progress();selection=self.state.selection()
        common={'job_id':self.job_id,'model_id':self.record['model_id'],'enrollment_id':self.record['enrollment_id'],'request_id':self.state.request['request_id'],'epoch':int(progress.get('latest_epoch',0) or 0),'selected_shift':selection.get('selected_semitone_shift') if selection else None,'stage_code':public_training_stage(progress),'progress_updated_at':public_progress_time(progress),'worker_updated_at':datetime.now(timezone.utc).isoformat()}
        if RUNTIME is not None:RUNTIME.progress(self.sid,progress,bool(selection))
        if selection:return {**common,'phase':'TRAINING','package_id':'','options':[]}
        try:
            selection=automatic.select_if_ready(self.root,self.request_path,self.record)
        except (ValueError,OSError) as error:
            if str(error)!=getattr(self,'last_auto_error',None):
                note('Automatic pitch selection needs operator review',error,'KEY_SELECTION_REVIEW',self.sid)
                self.last_auto_error=str(error)
            # Display review status without falsely ending the still-running
            # producer or exposing a choice to the customer.
            return {**common,'phase':'TRAINING','stage_code':'REVIEW_REQUIRED','operator_attention':'KEY_SELECTION_REVIEW','package_id':'','options':[]}
        if selection:common['selected_shift']=selection['selected_semitone_shift']
        if RUNTIME is not None:RUNTIME.update(operator_code='')
        return {**common,'phase':'TRAINING','package_id':'','options':[]}
    def tick(self):
        remote=self.api.json(f'/api/transfer/sessions/{self.sid}/phone-flow')['state']
        # Never replace a human choice that was already submitted before cutover.
        if remote and remote.get('command'):
            if self.request():
                self.api.json(f'/api/transfer/sessions/{self.sid}/phone-flow','PUT',{'job_id':self.job_id,'model_id':self.record['model_id'],'enrollment_id':self.record['enrollment_id'],'phase':'TRAINING','stage_code':'REVIEW_REQUIRED','package_id':remote.get('package_id',''),'options':[]})
            return
        packet=self.packet()
        if packet is not None:self.api.json(f'/api/transfer/sessions/{self.sid}/phone-flow','PUT',packet)

class Sequence:
    def __init__(self,root,api,state_dir):
        self.root=root;self.api=api;self.state_dir=state_dir
        sys.path.insert(0,str(root/'Services/PX_Admin'))
        import px_wix_customer_link as links,px_customer_training_intake as intake,px_voice_certification_handoff as cert
        import px_customer_training_owner as owners
        import px_customer_registration as registration
        self.registration=registration
        self.owners=owners
        self.links=links;self.intake=intake;self.cert=cert;self.db=root/'Data/PX_Admin/PX_Admin.sqlite3'
    def push(self,sid,record,job_id,phase):
        return self.api.json(f'/api/transfer/sessions/{sid}/phone-flow','PUT',{'job_id':job_id,'model_id':record['model_id'],'enrollment_id':record['enrollment_id'],'phase':phase,'options':[]})
    def fail_before_launch(self,sid):
        return  # Do not invent a remote enrollment or terminal claim before source review.
    def finish_existing(self,sid,local,state_path,proc,log_path):
        from px_runtime_health import stop_requested
        relay=KeyRelay(self.root,self.api,sid,local['record'],local['job_id']);failures=0
        while proc.poll() is None:
            if RUNTIME is not None:RUNTIME.update(state='DRAINING' if stop_requested(self.root) else 'RUNNING',session_id=sid,executive_process_id=proc.pid)
            try:
                relay.tick();failures=0
                if RUNTIME is not None:RUNTIME.update(transport='OK')
            except (urllib.error.URLError,TimeoutError,json.JSONDecodeError,OSError) as error:
                failures+=1
                if RUNTIME is not None:RUNTIME.update(transport='RETRY')
                note('Capture status update pending; existing Executive work was left running',error,'NETWORK_RETRY',sid)
            time.sleep(min(60,3*(2**min(failures,5))))
        code=proc.wait()
        if code!=0:raise RuntimeError('Executive Office training or certification did not succeed. See local run log.')
        from px_capture_runtime import exact_ready
        result=exact_ready(log_path,sid,local['record'])
        if result is None:raise RuntimeError('Exact Executive certification result is missing; no training was restarted.')
        local.update(phase='READY_PENDING_PHONE',result=result);pickup.atomic_json(state_path,local)
        self.push(sid,local['record'],local['job_id'],'READY');local.update(phase='READY');pickup.atomic_json(state_path,local)
        if RUNTIME is not None:RUNTIME.update(session_id='',stage='',epoch=0,executive_process_id=None,operator_code='',transport='OK')
        print(f'CUSTOMER SEQUENCE READY: {sid}',flush=True)

    def recover(self,sid,local,state_path):
        from px_capture_runtime import ExistingExecutive,exact_ready
        from px_runtime_health import process_token
        import px_customer_training_executive as executive
        record=local['record'];log_path=self.root/'Voices'/record['wix_member_id']/sid/'Phone_Executive_Console.log'
        if record.get('session_id')!=sid or local.get('job_id')!='PXPHONE-'+sid.replace('-','') or executive.read_enrollment(self.db,record['enrollment_id'])!=record:
            raise RuntimeError('Recovery enrollment identity differs; no work restarted.')
        pid=local.get('executive_process_id');token=local.get('executive_process_token')
        live=type(pid) is int and isinstance(token,str) and token and process_token(pid)==token
        ready=log_path.is_file() and exact_ready(log_path,sid,record) is not None
        if not live and not ready:
            note('Capture recovery requires operator review; no matching live Executive or certified result',None,'RECOVERY_REVIEW',sid)
            self.push(sid,record,local['job_id'],'REVIEW_REQUIRED')
            local['phase']='REVIEW_REQUIRED';pickup.atomic_json(state_path,local);return
        # Identity-bound observer only. This path cannot call Popen.
        proc=ExistingExecutive(pid or 0,token)
        self.finish_existing(sid,local,state_path,proc,log_path)

    def process(self,sid):
        if not pickup.UUID.fullmatch(sid):raise RuntimeError('Invalid phone session ID.')
        state_path=self.state_dir/(sid+'.json')
        existing=load(state_path) if state_path.exists() else None
        if existing:
            if existing['phase']=='READY_PENDING_PHONE':
                self.push(sid,existing['record'],existing['job_id'],'READY')
                existing['phase']='READY';pickup.atomic_json(state_path,existing);return
            if existing['phase'] in ('READY','FAILED','REVIEW_REQUIRED'):return
            # Reattach only to the persisted process creation identity; never relaunch.
            self.recover(sid,existing,state_path);return
        from px_runtime_health import stop_requested
        if stop_requested(self.root):return
        envelope=self.links.fetch_session(self.api.url,sid,self.api.token);verify_finish(envelope)
        self.registration.ensure_customer(self.db,envelope,sid)
        customer=self.owners.resolve(self.db,envelope,sid)
        member=customer['wix_member_id'];customer_id=customer['customer_id']
        folder=self.root/'Voices'/member/sid
        self.owners.review_supplied(envelope,folder,customer)
        self.links.bind(self.db,envelope,sid,customer_id)
        draft_path=folder/'Training_Intake/Training_Intake_Draft.json'
        model=customer['model_id']
        registry=self.cert.load(self.root/'Modules/PXM-011/Voice_Model_Registry.json')
        if any(r.get('model_id')==model for r in registry.get('models',[])):raise RuntimeError('Phone-test model is already registered.')
        with closing(self.links.connect(self.db)) as con:
            enrolled=con.execute('SELECT enrollment_json FROM voice_training_enrollments WHERE session_id=?',(sid,)).fetchall()
        if len(enrolled)>1:raise RuntimeError('Multiple enrollments claim one phone session.')
        if enrolled:record=json.loads(enrolled[0][0])
        else:
            if not draft_path.exists():
                ffmpeg=self.cert.load(self.root/'Config/PX_Config.json')['ffmpeg']
                draft_path=self.intake.prepare(self.root,self.db,envelope,sid,customer_id,model,customer['display_name'],ffmpeg)
            # Finish approved the exact saved source clips. All normal intake integrity checks remain.
            record=self.intake.approve(self.db,draft_path,envelope)
        if record['model_id']!=model or record['wix_member_id']!=member or record['admin_customer_id']!=customer_id:raise RuntimeError('Phone enrollment identity mismatch.')
        job_id='PXPHONE-'+sid.replace('-','');local={'phase':'CLAIMED','job_id':job_id,'record':record,'phone_test_context':envelope['manifest']['phone_training'].get('test_context',{}),'phone_approved_clips_sha256':envelope['manifest']['phone_training']['source_clips_sha256']}
        pickup.atomic_json(state_path,local)
        try:
            self.push(sid,record,job_id,'PREPARING')
            env=os.environ.copy();env['VOICE_TRANSFER_TOKEN']=self.api.token;env['PX_PHONE_TRAINING_ENROLLMENT']=record['enrollment_id']
            log_path=folder/'Phone_Executive_Console.log'
            with log_path.open('w',encoding='utf-8') as log:
                proc=subprocess.Popen([sys.executable,str(self.root/'Modules/PXM-000/pxm000_executive_office.py'),'--customer-training-enrollment',record['enrollment_id'],'--publish-ready','--url',self.api.url],cwd=str(self.root),env=env,stdout=log,stderr=subprocess.STDOUT)
                from px_runtime_health import process_token
                token=process_token(proc.pid)
                local.update(phase='RUNNING',executive_process_id=proc.pid,executive_process_token=token);pickup.atomic_json(state_path,local)
                self.finish_existing(sid,local,state_path,proc,log_path)
        except BaseException:
            if local['phase']=='READY_PENDING_PHONE':
                print('Certified READY result saved; phone notification will retry without retraining.',flush=True)
                return
            local['phase']='REVIEW_REQUIRED';pickup.atomic_json(state_path,local)
            try:self.push(sid,record,job_id,'REVIEW_REQUIRED')
            except Exception:pass
            raise

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--url',default='https://sdp-backend-6xt7.onrender.com');parser.add_argument('--engine',type=Path,default=Path('D:/Working/Project_X/PX_Engine'));parser.add_argument('--supervised',action='store_true');args=parser.parse_args()
    root=args.engine.resolve();sys.path.insert(0,str(root/'Services/PX_Admin'))
    from px_transfer_credential import get_transfer_token
    from px_runtime_health import stop_requested
    from px_capture_runtime import CaptureRuntime,SilentConsole
    if args.supervised:sys.stdout=sys.stderr=SilentConsole(root)
    global RUNTIME
    RUNTIME=CaptureRuntime(root,__file__,args.supervised)
    token=get_transfer_token()
    if len(token.encode())<32:raise RuntimeError('Transfer token must be at least 32 characters.')
    api=Api(args.url,token);state_dir=root/'Data/Phone_Sequence';state_dir.mkdir(parents=True,exist_ok=True)
    pickup_dir=root/'Data/Voice_Transfer_Pickup';pickup_dir.mkdir(parents=True,exist_ok=True)
    # The original pickup lock prevents two workers from racing the same transfer.
    with pickup.WorkerLock(pickup_dir/'Pickup.lock'):
        worker=pickup.PickupWorker(args.url,root/'Voices',pickup_dir,token);sequence=Sequence(root,api,state_dir)
        print('CUSTOMER SEQUENCE ACTIVE: automatic pickup, Executive training, automatic key selection and certification. Ctrl+C stops this worker.',flush=True)
        RUNTIME.start();failures=0
        try:
            while not stop_requested(root):
                try:
                    RUNTIME.update(stage='QUEUE_CHECK',session_id='')
                    worker.scan()
                    if worker.state.get('pending'):RUNTIME.message('Some capture transfers are pending verification',code='PICKUP_RETRY')
                    for row in api.json('/api/transfer/phone-jobs')['sessions']:
                        if stop_requested(root):break
                        sid=row['session_id']
                        try:sequence.process(sid)
                        except Exception as error:
                            if not pickup.UUID.fullmatch(sid):raise
                            note('Capture job needs review',error,'JOB_REVIEW',sid)
                            sequence.fail_before_launch(sid)
                    failures=0;RUNTIME.update(transport='OK')
                    if not worker.state.get('pending') and not RUNTIME.data.get('session_id'):RUNTIME.update(operator_code='')
                except Exception as error:
                    failures+=1;RUNTIME.update(transport='RETRY')
                    note('Capture queue check will retry',error,'NETWORK_RETRY')
                delay=min(120,10*(2**min(failures,4)))
                for _ in range(delay):
                    if stop_requested(root):break
                    time.sleep(1)
        finally:RUNTIME.close()
if __name__=='__main__':
    try:main()
    except KeyboardInterrupt:print('\nPhone sequence worker stopped. Review any active training before restarting.')
