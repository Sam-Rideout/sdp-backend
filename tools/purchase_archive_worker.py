"""Send queued 100-song purchase-history PDFs as email attachments.

Run on a trusted worker with VOICE_TRANSFER_TOKEN and the PX_CONSENT_SMTP_*
environment variables already configured. This worker never logs addresses,
PDF contents, or credentials.
"""
import argparse, base64, json, os, re, smtplib, ssl, time, urllib.request
from email.message import EmailMessage
from urllib.parse import urlsplit


def https_origin(value):
    parts = urlsplit(value)
    if parts.scheme != 'https' or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or parts.path not in ('', '/'):
        raise ValueError('An HTTPS backend origin is required.')
    return value.rstrip('/')


class Api:
    def __init__(self, origin, token):
        if not token:
            raise ValueError('VOICE_TRANSFER_TOKEN is required.')
        self.origin, self.token = https_origin(origin), token

    def post(self, route, body):
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs): return None
        request = urllib.request.Request(self.origin + '/api/transfer/purchase-history-archive/' + route,
            data=json.dumps(body).encode(), method='POST',
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        with urllib.request.build_opener(NoRedirect).open(request, timeout=45) as response:
            data = response.read(12_000_001)
            if len(data) > 12_000_000:
                raise ValueError('Purchase archive response is oversized.')
            return json.loads(data)


def smtp_sender(env):
    host, user, password, sender = (env.get(k, '') for k in
        ('PX_CONSENT_SMTP_HOST', 'PX_CONSENT_SMTP_USER', 'PX_CONSENT_SMTP_PASSWORD', 'PX_CONSENT_MAIL_FROM'))
    port = int(env.get('PX_CONSENT_SMTP_PORT', '465'))
    if not host or not user or not password or not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+', sender):
        raise ValueError('Purchase archive SMTP configuration is incomplete.')

    def send(job):
        recipient = job.get('to', '')
        if not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+', recipient):
            raise ValueError('Purchase archive recipient is invalid.')
        archive_id = job.get('archive_id', '')
        if not re.fullmatch(r'[a-f0-9]{64}', archive_id):
            raise ValueError('Purchase archive identity is invalid.')
        filename = job.get('filename', '')
        if not re.fullmatch(r'Project-X-Purchases-[1-9][0-9]*\.pdf', filename):
            raise ValueError('Purchase archive filename is invalid.')
        pdf = base64.b64decode(job.get('pdf_base64', ''), validate=True)
        if not pdf.startswith(b'%PDF-1.4') or len(pdf) > 8_000_000:
            raise ValueError('Purchase archive PDF is invalid.')
        message = EmailMessage()
        message['From'], message['To'] = sender, recipient
        message['Subject'] = 'Your Project X purchase-history summary'
        message['Message-ID'] = f'<purchase-archive-{archive_id}@sdpsongs.ca>'
        message.set_content('Attached is your Project X summary of 100 completed song purchases. '
            'Songs redeemed with credits are included. Test, refunded, and free promotional songs are excluded. '
            'Your purchase records remain saved with Project X for your account history.')
        message.add_attachment(pdf, maintype='application', subtype='pdf', filename=filename)
        with smtplib.SMTP_SSL(host, port, timeout=30, context=ssl.create_default_context()) as smtp:
            smtp.login(user, password)
            refused = smtp.send_message(message)
            if refused:
                raise RuntimeError('Mail server refused the purchase archive recipient.')

    return send


def cycle(api, send):
    result = {'sent': 0, 'issues': []}
    jobs = api.post('work', {}).get('jobs', [])
    for job in jobs:
        archive_id, claim_id = job.get('archive_id'), job.get('claim_id')
        try:
            send(job)
        except Exception as exc:
            try:
                api.post('ack', {'archive_id': archive_id, 'claim_id': claim_id, 'sent': False})
            except Exception:
                pass
            result['issues'].append({'archive_id': archive_id, 'error': type(exc).__name__})
            continue
        api.post('ack', {'archive_id': archive_id, 'claim_id': claim_id, 'sent': True})
        result['sent'] += 1
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--loop', action='store_true')
    parser.add_argument('--interval', type=int, default=3600)
    args = parser.parse_args()
    if not 60 <= args.interval <= 3600:
        parser.error('Interval must be 60–3600 seconds.')
    api = Api(os.environ.get('PX_PURCHASE_ARCHIVE_BACKEND_ORIGIN', 'https://sdp-backend-6xt7.onrender.com'),
        os.environ.get('VOICE_TRANSFER_TOKEN', ''))
    send = smtp_sender(os.environ)
    while True:
        print(json.dumps(cycle(api, send)), flush=True)
        if not args.loop:
            break
        time.sleep(args.interval)


if __name__ == '__main__':
    main()
