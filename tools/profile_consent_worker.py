"""Deliver renewal reminders and request expiry through the authenticated backend.
No audio/model filesystem access. Run beside the existing PC deletion worker.
"""
import argparse, json, os, re, smtplib, ssl, time, urllib.request
from datetime import datetime
from email.message import EmailMessage
from urllib.parse import urlsplit, quote

class Api:
    def __init__(self, origin, token):
        p = urlsplit(origin)
        if p.scheme != 'https' or not p.hostname or p.username or p.password or p.query or p.fragment or p.path not in ('', '/'):
            raise ValueError('An HTTPS backend origin is required.')
        if not token:
            raise ValueError('VOICE_TRANSFER_TOKEN is required.')
        self.origin, self.token = origin.rstrip('/'), token
    def post(self, route, body):
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs): return None
        request = urllib.request.Request(self.origin + '/api/transfer/profile-consent/' + route,
            data=json.dumps(body).encode(), method='POST',
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            data = response.read(2_000_001)
            if len(data) > 2_000_000: raise ValueError('Unexpected retention response size.')
            return json.loads(data)

def reminder_message(claim, origin, sender):
    if not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+', claim['to']):
        raise ValueError('Invalid account email.')
    deadline = claim['expires_at']
    datetime.fromisoformat(deadline.replace('Z', '+00:00'))
    link = origin.rstrip('/') + '/profile-consent#token=' + quote(claim['renewal_token'], safe='')
    message = EmailMessage()
    message['From'], message['To'] = sender, claim['to']
    message['Subject'] = ('Last chance to keep your Project X voice profile — deletion tomorrow' if claim.get('notice_kind') == 'ONE_DAY' else 'Action needed: renew your Project X voice consent before deletion')
    message['Message-ID'] = claim['message_id']
    message.set_content(('LAST CHANCE: your consent expires tomorrow. Re-sign now to keep your existing voice profile.\n\n' if claim.get('notice_kind') == 'ONE_DAY' else '') + 'Your Project X voice profile is scheduled for deletion unless you re-sign consent before this deadline:\n\n'
        + deadline + ' (UTC; your renewal page shows Atlantic local time).\n\n'
        'Read the consent terms and re-sign here:\n' + link + '\n\n'
        'Re-signing before the deadline keeps the same recordings, trained voice profile, calibration and linked information for a fresh 90 days. '
        'You do not need to record or train your voice again. Optional improvement use is a separate choice.\n\n'
        'If you take no action, your profile becomes unavailable at the deadline and its voice data is scheduled for active deletion. '
        'Backup limits apply. Deletion may wait for active processing or verification.\n\n'
        'If you have already renewed, your latest confirmation deadline applies and no further action is needed.\n'
        'Keep this link private. It authorizes renewal of this profile only.\n'
        'Questions: sdp.projectx.contact@gmail.com\n')
    return message

def smtp_sender(env):
    host, user, password, sender = (env.get(k, '') for k in ('PX_CONSENT_SMTP_HOST', 'PX_CONSENT_SMTP_USER', 'PX_CONSENT_SMTP_PASSWORD', 'PX_CONSENT_MAIL_FROM'))
    port = int(env.get('PX_CONSENT_SMTP_PORT', '465'))
    if not host or not user or not password or not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+', sender):
        raise ValueError('Renewal SMTP configuration is incomplete.')
    def send(message):
        # Verified implicit TLS only; no plaintext authentication fallback.
        with smtplib.SMTP_SSL(host, port, timeout=30, context=ssl.create_default_context()) as smtp:
            smtp.login(user, password)
            refused = smtp.send_message(message)
            if refused: raise RuntimeError('Mail server refused the reminder recipient.')
    return send, sender

def cycle(api, send, sender, *, validate_recipient=None, email_enabled=True):
    result = {'reminders_sent': 0, 'expiry_requests': 0, 'issues': []}
    for item in api.post('work', {}):
        try:
            if item['action'] == 'REMIND':
                if not email_enabled: continue
                claim = api.post('claim-reminder', item)
                if claim.get('already_sent'): continue
                try:
                    if validate_recipient is not None: validate_recipient(item, claim)
                    send(reminder_message(claim, api.origin, sender))
                except Exception:
                    api.post('ack-reminder', {**item, 'claim_id': claim['claim_id'], 'sent': False})
                    raise
                api.post('ack-reminder', {**item, 'claim_id': claim['claim_id'], 'sent': True})
                result['reminders_sent'] += 1
            elif item['action'] == 'EXPIRE':
                api.post('expire', item)
                result['expiry_requests'] += 1
        except Exception as exc:
            # Never log response bodies, customer email, renewal links or credentials.
            result['issues'].append({'event_sha256': item.get('event_sha256'), 'error': type(exc).__name__})
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--loop', action='store_true')
    parser.add_argument('--interval', type=int, default=300)
    args = parser.parse_args()
    if not 60 <= args.interval <= 3600: parser.error('Interval must be 60–3600 seconds.')
    api = Api(os.environ.get('PX_CONSENT_BACKEND_ORIGIN', 'https://sdp-backend-6xt7.onrender.com'), os.environ.get('VOICE_TRANSFER_TOKEN', ''))
    send, sender = smtp_sender(os.environ)
    while True:
        print(json.dumps(cycle(api, send, sender)), flush=True)
        if not args.loop: break
        time.sleep(args.interval)
if __name__ == '__main__':
    main()
