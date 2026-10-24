"""Build a private review inventory from connector Gmail JSON; never grants identity or consent.

python3 scripts/extract-gmail-contacts.py --input export.json --output-dir /private/output
Input: {messages: [search metadata], bodies: [Gmail MIME messages], coverage: {...}}.
Outputs contain personal data. Keep them outside this public repository.
"""
import argparse
import csv
import hashlib
import json
import re
from email.utils import getaddresses
from datetime import datetime, timezone
from pathlib import Path

OWN = {'r2nette.ca@gmail.com', 'takatak.ca@gmail.com', 'aide@r2nette.ca',
       'evaluation@r2nette.ca', 'recouvrement@r2nette.ca'}
SERVICE = re.compile(r'facture|invoice|ménage|menage|cleaning|soumission|estimat|réservation|reservation|appointment scheduled|new appointment|contrat|reçu', re.I)
AUTOMATED = re.compile(r'no[._-]?reply|notification|newsletter|mailer|bounce|support|help@|billing@|noreply|@setmore\.com|@google\.com|@housecallpro\.com', re.I)
EMAIL = re.compile(r'^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$')


def text_parts(part):
    if not isinstance(part, dict):
        return []
    result = []
    if part.get('mime_type') == 'text/plain' and (part.get('body') or {}).get('content'):
        result.append(part['body']['content'])
    for child in part.get('parts') or []:
        result.extend(text_parts(child))
    return result


def csv_safe(value):
    value = str(value)
    return "'" + value if value.lstrip().startswith(('=', '+', '-', '@')) else value


def build_inventory(data):
    metadata = {m['id']: m for m in data.get('messages', []) if m.get('id')}
    body_map = {m['id']: m for m in data.get('bodies', []) if m.get('id')}
    contacts, sources = {}, []
    for mid, message in sorted(metadata.items()):
        body = body_map.get(mid, {})
        headers = {h['name'].lower(): h['value'] for h in (body.get('payload') or {}).get('headers', [])}
        subject = message.get('subject') or headers.get('subject', '')
        date = message.get('email_ts', '')
        try:
            date = datetime.fromisoformat(date.replace('Z', '+00:00')).astimezone(timezone.utc).isoformat()
        except (ValueError, TypeError):
            date = ''
        url = message.get('display_url', '')
        sent = 'SENT' in (message.get('labels') or [])
        # Use direct correspondence headers; do not turn quoted third parties or
        # every email-shaped string in newsletters into a customer database.
        header = headers.get('to' if sent else 'from', '')
        raw = [header] if header else ((message.get('to') or []) if sent else [message.get('from_', '')])
        # Search summaries may flatten "Name <email>" to "Name email".
        # Prefer original MIME headers; normalize only a complete fallback.
        normalized = []
        for value in raw:
            flat = re.fullmatch(r'([^<>]+?)\s+([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)', value)
            normalized.append(f'"{flat[1].strip(chr(34))}" <{flat[2]}>' if flat else value)
        for name, email in getaddresses(normalized):
            email = email.lower().strip()
            if not EMAIL.fullmatch(email) or email in OWN or email.endswith('@r2nette.ca'):
                continue
            candidate = bool(SERVICE.search(subject)) and not AUTOMATED.search(email)
            record = contacts.setdefault(email, {
                'contact_id': 'r2-' + hashlib.sha256(email.encode()).hexdigest()[:16],
                'email': email, 'display_name': '', 'relationship': 'correspondent_a_revoir',
                'marketing_status': 'inconnu', 'marketing_eligible': False,
                'identity_verified': False, 'first_seen': date, 'last_seen': date,
                'source_ids': [], 'source_url': url,
            })
            if name and name.lower() != email:
                record['display_name'] = name.strip('" ')
            if candidate:
                record['relationship'] = 'client_ou_prospect_a_confirmer'
            record['first_seen'] = min(filter(None, [record['first_seen'], date]), default='')
            record['last_seen'] = max(record['last_seen'], date)
            record['source_ids'].append(mid)
            sources.append([record['contact_id'], mid, date, 'envoye' if sent else 'recu', url])
    rows = sorted(contacts.values(), key=lambda c: (c['relationship'], c['email']))
    # Only direct provider messages count as booking evidence. Forwarded and
    # quoted confirmations are never silently turned into live appointments.
    bookings = []
    for mid, body in body_map.items():
        headers = {h['name'].lower(): h['value'] for h in (body.get('payload') or {}).get('headers', [])}
        sender = getaddresses([headers.get('from', '')])
        if not any(e.lower() == 'no-reply@setmore.com' for _, e in sender):
            continue
        text = '\n'.join(text_parts(body.get('payload')))
        booking = re.search(r'Booking ID:\s*\n\s*([A-Za-z0-9_-]+)', text)
        when = re.search(r'When:\s*\n\s*([^\r\n]+)', text)
        service = re.search(r'Cleaning Service:\s*\n\s*([^\r\n]+)', text)
        if booking:
            bookings.append([booking[1], when[1] if when else '', service[1] if service else '', mid,
                             metadata.get(mid, {}).get('display_url', ''), 'historique_a_verifier'])
    unique = {row[0]: row for row in bookings}
    return {'source_account': 'r2nette.ca@gmail.com', 'contacts': rows, 'sources': sources, 'bookings': list(unique.values()),
            'coverage': data.get('coverage', {}), 'message_count': len(metadata),
            'body_count': len(body_map)}


def write_inventory(result, target):
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    target.chmod(0o700)
    columns = ['contact_id', 'display_name', 'email', 'relationship', 'marketing_status',
               'marketing_eligible', 'identity_verified', 'first_seen', 'last_seen', 'source_count', 'source_url']
    contacts = [[c[k] if k != 'source_count' else len(set(c['source_ids'])) for k in columns]
                for c in result['contacts']]
    tables = {
        'Contacts': [columns] + contacts,
        'Sources': [['contact_id', 'message_id', 'date', 'direction', 'source_url']] + result['sources'],
        'Reservations': [['booking_id', 'date_source', 'service_source', 'message_id', 'source_url', 'statut']] + result['bookings'],
    }
    for name, table in tables.items():
        path = target / (name.lower() + '.csv')
        with path.open('w', encoding='utf-8-sig', newline='') as handle:
            csv.writer(handle).writerows([[csv_safe(v) for v in row] for row in table])
        path.chmod(0o600)
    path = target / 'inventory.json'
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    path.chmod(0o600)
    return tables


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    # Refuse the public source tree even if an operator supplies a bad path.
    repository = Path(__file__).resolve().parents[1]
    output = args.output_dir.resolve()
    if output == repository or repository in output.parents:
        parser.error('Personal data output must be outside the source repository.')
    result = build_inventory(json.loads(args.input.read_text(encoding='utf-8')))
    tables = write_inventory(result, output)
    print(json.dumps({'tables': tables, 'counts': {'messages': result['message_count'],
          'bodies': result['body_count'], 'contacts': len(result['contacts']),
          'bookings': len(result['bookings']), 'marketing_eligible': 0},
          'coverage': result['coverage']}, ensure_ascii=False))
