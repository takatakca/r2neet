import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('extract', Path(__file__).with_name('extract-gmail-contacts.py'))
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)


class InventoryTests(unittest.TestCase):
    def message(self, mid, recipient, subject='Cleaning contract'):
        return {'id': mid, 'to': [recipient], 'subject': subject, 'labels': ['SENT'],
                'email_ts': '2026-10-22T12:00:00Z', 'display_url': 'https://mail.google.com/#all/' + mid}

    def test_deduplicates_sources_without_granting_identity_or_consent(self):
        m = self.message('one', 'Test Person <TEST@example.com>')
        result = extract.build_inventory({'messages': [m, m, self.message('two', 'test@example.com')]})
        self.assertEqual(len(result['contacts']), 1)
        self.assertEqual(len(result['sources']), 2)
        c = result['contacts'][0]
        self.assertEqual(c['relationship'], 'client_ou_prospect_a_confirmer')
        self.assertFalse(c['identity_verified'])
        self.assertFalse(c['marketing_eligible'])
        self.assertEqual(c['marketing_status'], 'inconnu')

    def test_excludes_own_addresses_and_does_not_promote_provider(self):
        data = {'messages': [self.message('one', 'aide@r2nette.ca'),
                             self.message('two', 'no-reply@setmore.com')]}
        result = extract.build_inventory(data)
        self.assertEqual(len(result['contacts']), 1)
        self.assertEqual(result['contacts'][0]['relationship'], 'correspondent_a_revoir')

    def test_flattened_search_names_and_original_mime_headers(self):
        message = self.message('one', 'Test Person person@example.com')
        result = extract.build_inventory({'messages': [message]})
        self.assertEqual(result['contacts'][0]['email'], 'person@example.com')
        self.assertEqual(result['contacts'][0]['display_name'], 'Test Person')
        message['to'] = ['Wrong Summary wrong@example.com']
        result = extract.build_inventory({'messages': [message], 'bodies': [{'id': 'one', 'payload': {
            'headers': [{'name': 'To', 'value': 'Test Person <person@example.com>'}]}}]})
        self.assertEqual(result['contacts'][0]['email'], 'person@example.com')

    def test_does_not_extract_quoted_contacts_or_access_codes(self):
        data = {'messages': [self.message('one', 'person@example.com')],
                'bodies': [{'id': 'one', 'payload': {'mime_type': 'text/plain', 'body': {
                    'content': 'Door code 1234; forwarded from stranger@example.com'}}}]}
        result = extract.build_inventory(data)
        self.assertEqual([c['email'] for c in result['contacts']], ['person@example.com'])
        self.assertNotIn('1234', str(result))

    def test_direct_booking_only_and_idempotent_evidence(self):
        payload = {'headers': [{'name': 'From', 'value': 'no-reply@setmore.com'}],
                   'mime_type': 'text/plain', 'body': {'content': 'Booking ID:\nABC123\nWhen:\nTue Aug 16, 2022\nCleaning Service:\nBasic'}}
        result = extract.build_inventory({'bodies': [{'id': 'one', 'payload': payload},
                                                     {'id': 'two', 'payload': payload}]})
        self.assertEqual(len(result['bookings']), 1)
        self.assertEqual(result['bookings'][0][-1], 'historique_a_verifier')

    def test_csv_neutralizes_formula_and_files_are_private(self):
        self.assertEqual(extract.csv_safe('  =1+1'), "'  =1+1")
        result = extract.build_inventory({'messages': [self.message('one', 'test@example.com')]})
        with tempfile.TemporaryDirectory() as root:
            out = Path(root) / 'export'
            extract.write_inventory(result, out)
            self.assertEqual((out / 'contacts.csv').stat().st_mode & 0o777, 0o600)
            self.assertEqual(out.stat().st_mode & 0o777, 0o700)


if __name__ == '__main__':
    unittest.main()
