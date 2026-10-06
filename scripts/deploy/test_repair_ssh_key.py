"""Tests for repair-ssh-key.py with real keys and ssh-keygen.

    python3 -m unittest scripts/deploy/test_repair_ssh_key.py
"""
from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("repair", Path(__file__).with_name("repair-ssh-key.py"))
repair = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = repair
spec.loader.exec_module(repair)

SCRIPT = Path(__file__).with_name("repair-ssh-key.py")


class RepairSshKey(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.keys = {}
        for kind, args in {
            "ed25519": ["-t", "ed25519"],
            "rsa-pem": ["-t", "rsa", "-b", "2048", "-m", "PEM"],
            "ecdsa": ["-t", "ecdsa"],
        }.items():
            path = cls.dir / kind
            subprocess.run(["ssh-keygen", "-q", "-N", "", "-C", "test", "-f", str(path), *args], check=True)
            cls.keys[kind] = path.read_text()
        cls.public = (cls.dir / "ed25519.pub").read_text()
        ec_params = cls.dir / "ec-params.pem"
        # openssl's default output: an EC PARAMETERS block, then the key.
        subprocess.run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-out", str(ec_params)], check=True)
        cls.ec_with_params = ec_params.read_text()
        encrypted = cls.dir / "encrypted"
        subprocess.run(
            ["ssh-keygen", "-q", "-N", "secret-pass", "-m", "PEM", "-t", "rsa", "-b", "2048", "-f", str(encrypted)],
            check=True,
        )
        cls.encrypted_pem = encrypted.read_text()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_script(self, text: str) -> tuple[subprocess.CompletedProcess, Path]:
        path = self.dir / "candidate"
        path.write_text(text)
        path.chmod(0o600)
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(path), "CONTABO_ROOT_SSH_KEY"], capture_output=True, text=True
        )
        return result, path

    def assert_ssh_reads(self, path: Path, original: str):
        """ssh-keygen derives the same public key from the repaired file."""
        want_path = self.dir / "want"
        want_path.write_text(original)
        want_path.chmod(0o600)
        want = subprocess.run(["ssh-keygen", "-y", "-P", "", "-f", str(want_path)], capture_output=True, text=True)
        got = subprocess.run(["ssh-keygen", "-y", "-P", "", "-f", str(path)], capture_output=True, text=True)
        self.assertEqual(got.returncode, 0, "ssh-keygen could not read the repaired key")
        self.assertEqual(got.stdout.split()[:2], want.stdout.split()[:2])

    def assert_no_key_material(self, result: subprocess.CompletedProcess, key: str):
        body = [line for line in key.splitlines() if line and not line.startswith("-----")]
        for line in body:
            self.assertNotIn(line[:20], result.stdout + result.stderr)

    def test_intact_keys_still_work(self):
        for kind, key in self.keys.items():
            with self.subTest(kind=kind):
                result, path = self.run_script(key)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "")
                self.assert_ssh_reads(path, key)

    def test_windows_line_endings(self):
        key = self.keys["ed25519"]
        result, path = self.run_script(key.replace("\n", "\r\n"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("removed Windows line endings", result.stdout)
        self.assert_ssh_reads(path, key)

    def test_line_breaks_turned_into_spaces(self):
        for kind, key in self.keys.items():
            with self.subTest(kind=kind):
                result, path = self.run_script(key.strip().replace("\n", " "))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("restored the line breaks", result.stdout)
                self.assert_ssh_reads(path, key)

    def test_line_breaks_dropped(self):
        key = self.keys["ed25519"]
        result, path = self.run_script(key.replace("\n", ""))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("restored the line breaks", result.stdout)
        self.assert_ssh_reads(path, key)

    def test_text_around_the_key(self):
        key = self.keys["ed25519"]
        page = "Private Key\n  " + key.replace("\n", "\n    ") + "\nSave\nPublic Key ssh-ed25519 AAAA test\n"
        result, path = self.run_script(page)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ignored text before or after the key", result.stdout)
        self.assert_ssh_reads(path, key)

    def test_public_key_is_refused(self):
        result, _ = self.run_script(self.public)
        self.assertEqual(result.returncode, 2)
        self.assertIn("public key", result.stderr)

    def test_cut_off_copy_is_refused(self):
        key = self.keys["ed25519"]
        result, _ = self.run_script(key[: len(key) // 2])
        self.assertEqual(result.returncode, 2)
        self.assertIn("cut off", result.stderr)
        self.assert_no_key_material(result, key)

    def test_hidden_field_copy_is_refused(self):
        result, _ = self.run_script("-----BEGIN OPENSSH PRIVATE KEY-----\n••••••••\n-----END OPENSSH PRIVATE KEY-----\n")
        self.assertEqual(result.returncode, 2)
        self.assertIn("characters a key never has", result.stderr)

    def test_empty_and_unrelated_text_are_refused(self):
        for text, reason in [("\n", "is empty"), ("https://github.com/takatakca\n", "does not contain")]:
            with self.subTest(text=text):
                result, _ = self.run_script(text)
                self.assertEqual(result.returncode, 2)
                self.assertIn(reason, result.stderr)

    def test_other_pem_headers_are_kept(self):
        block = "-----BEGIN RSA PRIVATE KEY-----\nComment: test\n\nQUJD\n-----END RSA PRIVATE KEY-----"
        clean, notes = repair.repair(block)
        self.assertEqual(clean, block + "\n")
        self.assertEqual(notes, [])

    def test_extra_block_before_the_key(self):
        result, path = self.run_script(self.ec_with_params)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ignored text before or after the key", result.stdout)
        self.assert_ssh_reads(path, self.ec_with_params)

    def test_public_key_block_alone_is_refused(self):
        result, _ = self.run_script("-----BEGIN PUBLIC KEY-----\nQUJD\n-----END PUBLIC KEY-----\n")
        self.assertEqual(result.returncode, 2)
        self.assertIn("holds a PUBLIC KEY block, not a private key", result.stderr)

    def test_no_break_spaces(self):
        key = self.keys["ed25519"]
        result, path = self.run_script(key.replace(" ", "\u00a0"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("replaced special spaces", result.stdout)
        self.assert_ssh_reads(path, key)

    def test_invisible_characters(self):
        key = self.keys["ed25519"]
        lines = key.split("\n")
        damaged = "\ufeff" + "\n".join(
            line[:10] + "\u200b" + line[10:20] + "\u2060" + line[20:30] + "\u00ad" + line[30:]
            if line and not line.startswith("-----") else line
            for line in lines
        )
        result, path = self.run_script(damaged)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("removed invisible characters", result.stdout)
        self.assert_ssh_reads(path, key)

    def test_escaped_line_breaks_from_json(self):
        key = self.keys["ed25519"]
        for text in [key.replace("\n", "\\n"), '"' + key.replace("\n", "\\r\\n") + '"']:
            with self.subTest(text=text[:40]):
                result, path = self.run_script(text)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("escapes into line breaks", result.stdout)
                self.assert_ssh_reads(path, key)

    def test_cut_off_copy_then_whole_key(self):
        key = self.keys["ed25519"]
        pasted = "\n".join(key.split("\n")[:3]) + "\n" + key
        result, path = self.run_script(pasted)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ignored text before or after the key", result.stdout)
        self.assert_ssh_reads(path, key)

    def test_passphrase_protected_keys_are_refused_with_that_reason(self):
        for label, text in [("intact", self.encrypted_pem), ("one line", self.encrypted_pem.replace("\n", " "))]:
            with self.subTest(label):
                result, _ = self.run_script(text)
                self.assertEqual(result.returncode, 2)
                self.assertIn("protected by a passphrase", result.stderr)
                self.assert_no_key_material(result, self.encrypted_pem)
        with self.assertRaisesRegex(ValueError, "passphrase"):
            repair.repair("-----BEGIN ENCRYPTED PRIVATE KEY-----\nQUJD\n-----END ENCRYPTED PRIVATE KEY-----")

    def test_errors_never_echo_the_key(self):
        key = self.keys["rsa-pem"]
        result, _ = self.run_script(key.replace("-----END RSA PRIVATE KEY-----", ""))
        self.assertEqual(result.returncode, 2)
        self.assert_no_key_material(result, key)


if __name__ == "__main__":
    unittest.main()
