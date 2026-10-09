#!/usr/bin/env python3
"""Pick up finished voice sessions. No training, profile publication or production launch."""
import argparse
import getpass
import json
import os
import re
import sys
import time
from pathlib import Path
import transfer_voice_session as transfer

UUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')


def atomic_json(path, value):
    pending = path.with_suffix(path.suffix + '.tmp')
    pending.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    os.replace(pending, path)


class WorkerLock:
    def __init__(self, path): self.path = path
    def __enter__(self):
        self.handle = self.path.open('a+b')
        self.handle.seek(0); self.handle.write(b'0'); self.handle.flush(); self.handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.handle.close()
            raise RuntimeError('Another automatic pickup worker is already running.')
        return self
    def __exit__(self, *args): self.handle.close()


def contained_path(root, relative):
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise RuntimeError('Unsafe local verification path.')
    result = (root / relative).resolve()
    if not result.is_relative_to(root.resolve()): raise RuntimeError('Local verification path escapes session folder.')
    return result


def validate_local(envelope, destination):
    manifest = envelope['manifest']; sid = manifest['session_id']
    owner = envelope['profile_id']; program = manifest.get('program', 'CUSTOMER')
    if not isinstance(owner, str) or not owner or transfer.safe_component(owner) != owner:
        raise RuntimeError('Invalid owner identity.')
    if program not in ('CUSTOMER', 'LIMITED_HELPER_PILOT'): raise RuntimeError('Unknown recording program.')
    root = destination / ('Pilot_Testers' if program == 'LIMITED_HELPER_PILOT' else '') / owner / sid
    report = json.loads((root / 'Transfer_Verification.json').read_text(encoding='utf-8'))
    if (report.get('session_id'), report.get('profile_id'), report.get('program')) != (sid, owner, program):
        raise RuntimeError('Local transfer identity mismatch.')
    clips = [c for section in manifest.get('sections', {}).values() for c in section.get('takes', [])]
    clips += manifest.get('special_message', {}).get('takes', [])
    expected = {c['clip_id']: c['sha256'] for c in clips}
    actual = {c['clip_id']: c['sha256'] for c in report['verified_clips']}
    if not clips or len(expected) != len(clips) or len(actual) != len(report['verified_clips']) or expected != actual:
        raise RuntimeError('Local original-clip coverage mismatch.')
    for clip in clips:
        section, take = clip['section'], clip['take']
        if type(section) is not int or section not in range(1,10) or type(take) is not int or take < 1:
            raise RuntimeError('Invalid original-clip slot.')
        folder = 'Special_Message' if section == 9 else f'Section_{section:02d}'
        source = root / folder / f"Take_{take:02d}{Path(clip['file_name']).suffix.lower()}"
        data = source.read_bytes()
        if len(data) != clip['bytes'] or transfer.digest(data) != clip['sha256']:
            raise RuntimeError('Local original recording failed verification.')
    messages = [c for c in clips if c['section'] == 9]
    wavs = report.get('special_message_wavs', [])
    if len(wavs) != len(messages) or {r['clip_id'] for r in wavs} != {c['clip_id'] for c in messages}:
        raise RuntimeError('Local message WAV coverage mismatch.')
    for row in wavs:
        filename = contained_path(root, row['relative_path'])
        transfer.read_message_pcm(filename)
        if transfer.digest(filename.read_bytes()) != row['sha256'] or row['source_sha256'] != expected[row['clip_id']]:
            raise RuntimeError('Local message WAV identity mismatch.')
    return root, report


class PickupWorker:
    def __init__(self, url, destination, state_dir, token):
        self.url = url.rstrip('/'); self.destination = destination; self.state_dir = state_dir; self.token = token
        self.state_path = state_dir / 'Pickup_State.json'
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {'pending':[], 'completed':[], 'url':self.url, 'destination':str(destination)}
        if self.state.get('url') != self.url or self.state.get('destination') != str(destination):
            raise RuntimeError('Pickup state belongs to a different server or destination.')
        for sid in self.state['pending'] + self.state['completed']:
            if not UUID.fullmatch(sid): raise RuntimeError('Invalid persisted Session ID.')
    def save(self): atomic_json(self.state_path, self.state)
    def envelope(self, sid):
        raw, _ = transfer.request(f'{self.url}/api/transfer/sessions/{sid}', self.token)
        envelope = json.loads(raw)
        if envelope['manifest']['session_id'] != sid: raise RuntimeError('Server Session ID mismatch.')
        return envelope
    def finish(self, sid, envelope):
        if envelope['manifest']['status'] != 'TRANSFERRED_AUDIO_DELETED':
            raise RuntimeError('Render has not confirmed active audio deletion.')
        root, report = validate_local(envelope, self.destination)
        if report.get('render_audio_delete_requested') is not True:
            report['render_audio_delete_requested'] = True
            report['render_receipt'] = {'status':'TRANSFERRED_AUDIO_DELETED',
                'transferred_at':envelope['manifest'].get('transferred_at'),
                'recovered_from_terminal_manifest':True}
            atomic_json(root / 'Transfer_Verification.json', report)
            atomic_json(root / 'Session_Manifest.json', envelope['manifest'])
        atomic_json(root / 'Pickup_Receipt.json', {
            'schema_version':'PX-AUTOMATIC-VOICE-PICKUP-1.0', 'session_id':sid,
            'program':report['program'], 'profile_id':report['profile_id'],
            'local_master_folder':str(root), 'message_wav':report.get('message_wav', ''),
            'message_selection_required':report.get('message_selection_required', False),
            'status':'TRANSFER_VERIFIED', 'training_started':False, 'profile_ready':False,
            'completed_at':__import__('datetime').datetime.now().astimezone().isoformat()})
        self.state['pending'] = [item for item in self.state['pending'] if item != sid]
        if sid not in self.state['completed']: self.state['completed'].append(sid)
        self.save(); print(f'PICKUP COMPLETE: {sid} | {root}', flush=True)
    def process(self, sid):
        if sid in self.state['completed']: return
        if sid not in self.state['pending']: self.state['pending'].append(sid); self.save()
        try:
            envelope = self.envelope(sid)
            if envelope['manifest']['status'] == 'READY_FOR_TRANSFER':
                print(f'PICKUP STARTING: {sid}', flush=True)
                transfer.transfer(self.url, sid, self.destination, self.token)
                envelope = self.envelope(sid)
            self.finish(sid, envelope)
        except Exception as error:
            # If confirmation succeeded but its response or local report write was lost,
            # the next scan checks Render's terminal manifest and verified local files.
            print(f'PICKUP RETRY REQUIRED: {sid} | {error}', flush=True)
    def scan(self):
        for sid in list(self.state['pending']): self.process(sid)
        after = ''; cursors = set()
        while True:
            suffix = '?after=' + after if after else ''
            raw, _ = transfer.request(f'{self.url}/api/transfer/ready-sessions{suffix}', self.token)
            batch = json.loads(raw)
            for item in batch['sessions']:
                sid = item['session_id']
                if not isinstance(sid, str) or not UUID.fullmatch(sid): raise RuntimeError('Invalid ready Session ID.')
                if sid not in self.state['pending']: self.process(sid)
            after = batch.get('next_cursor')
            if not after: break
            if not isinstance(after, str) or not UUID.fullmatch(after) or after in cursors:
                raise RuntimeError('Invalid/repeated queue cursor.')
            cursors.add(after)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='https://sdp-backend-6xt7.onrender.com')
    parser.add_argument('--destination', type=Path, default=Path('D:/Working/Project_X/PX_Engine/Voices'))
    parser.add_argument('--state-dir', type=Path)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    destination = args.destination.expanduser().resolve()
    state_dir = args.state_dir or destination.parent / 'Data' / 'Voice_Transfer_Pickup'
    state_dir.mkdir(parents=True, exist_ok=True)
    token = os.environ.get('VOICE_TRANSFER_TOKEN') or getpass.getpass('Render transfer token (once for this worker): ')
    if len(token.encode('utf-8')) < 32: raise RuntimeError('Transfer token must be at least 32 characters.')
    with WorkerLock(state_dir / 'Pickup.lock'):
        worker = PickupWorker(args.url, destination, state_dir, token)
        print('Automatic pickup active. Checks every 30 seconds. Ctrl+C stops. Training is not started.', flush=True)
        while True:
            try: worker.scan()
            except Exception as error:
                print(f'QUEUE CHECK FAILED: {error}', flush=True)
                if args.once: return 1
            if args.once: return 1 if worker.state['pending'] else 0
            time.sleep(30)
if __name__ == '__main__':
    try: sys.exit(main())
    except KeyboardInterrupt: print('\nAutomatic pickup stopped.')
    except Exception as error: print(f'Pickup stopped: {error}', file=sys.stderr); sys.exit(1)
