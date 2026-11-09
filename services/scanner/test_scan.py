"""Deterministic tests: docker run --rm --network none --entrypoint python3
-v "$PWD/services/scanner/test_scan.py:/app/test_scan.py:ro" gbx-scanner:bounded-20261102
-m unittest -v test_scan
"""

import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import scan


class ScannerTests(unittest.TestCase):
    def setUp(self):
        self.root = scan.WORK / ("test-" + uuid.uuid4().hex)
        self.root.mkdir(parents=True)
        self.db = self.root / "database"
        self.db.mkdir()
        self.addCleanup(shutil.rmtree, self.root)
        self.db_patch = patch.object(scan, "DATABASE", self.db)
        self.work_patch = patch.object(scan, "WORK", self.root / "runs")
        self.db_patch.start()
        self.work_patch.start()
        self.addCleanup(self.db_patch.stop)
        self.addCleanup(self.work_patch.stop)
        self.now = int(time.time())
        self.header("main", self.now - 365 * 86400, 62)
        self.header("daily", self.now - 3600, 28000)
        self.header("bytecode", self.now - 14 * 86400, 339)
        self.payload = self.root / "payload"
        self.payload.write_bytes(b"bounded clean input")

    def header(self, name, timestamp, version):
        text = f"ClamAV-VDB:date:{version}:100:90:hash:signature:builder:{timestamp}"
        (self.db / (name + ".cvd")).write_bytes(text.encode().ljust(512, b" ") + b"fixture")

    def process(self, code, output=""):
        return subprocess.CompletedProcess([], code, output)

    def run_scan(self, code=0, output=None):
        result = {"verdict": "Error"}
        outputs = [self.process(0, "ClamAV 1.4.3/28000/date"),
                   *[self.process(0, "Verification OK.\n") for _ in scan.FAMILIES],
                   self.process(code, output if output is not None else f"{self.payload}: OK\n")]
        with patch.object(scan, "command", side_effect=outputs) as command:
            scan.scan_file(self.payload, self.root, result)
        return result, command

    def client(self):
        blob = Mock()
        blob.tags = {"owner": "preserve-me"}
        blob.get_blob_tags.side_effect = lambda **kwargs: dict(blob.tags)
        blob.set_blob_tags.side_effect = lambda tags, **kwargs: setattr(blob, "tags", tags)
        blob.get_blob_properties.return_value = SimpleNamespace(size=3, etag='"v1"')
        blob.download_blob.return_value.chunks.side_effect = lambda: iter([b"abc"])
        return blob

    def clean(self, path, work, result, database=None):
        self.assertEqual(path.read_bytes(), b"abc")
        result.update(verdict="No threats found", engine="1.4.3", reason="scanned",
                      signature_version="main:62/daily:28000", signature_date=scan.utc(self.now - 3600))

    def main(self, client, scanner=None):
        output = io.StringIO()
        with patch.object(scan, "blob_client", return_value=client), \
             patch.object(scan, "signature_client"), patch.object(scan, "restore_signatures"), \
             patch.object(scan, "scan_file", side_effect=scanner or self.clean), contextlib.redirect_stdout(output):
            code = scan.main(["--blob-name", "test/document.pdf"])
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        return code, json.loads(output.getvalue())

    def test_subprocess_wall_timeout(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            scan.command([sys.executable, "-c", "import time; time.sleep(10)"], 0.1)

    def test_digest_is_complete(self):
        target = self.root / "download"
        digest = scan.copy_bounded([b"ab", b"c"], target, 3)
        self.assertEqual(digest, hashlib.sha256(b"abc").hexdigest())
        self.assertEqual(target.read_bytes(), b"abc")

    def test_oversize_rejected_before_stream_consumed(self):
        chunks = Mock()
        with self.assertRaisesRegex(scan.ScanFailure, "200MB"):
            scan.copy_bounded(chunks, self.root / "download", scan.MAX_BYTES + 1)
        self.assertFalse((self.root / "download").exists())

    def test_stream_cannot_exceed_declared_size(self):
        with self.assertRaisesRegex(scan.ScanFailure, "download-size-exceeded"):
            scan.copy_bounded([b"ab", b"c"], self.root / "download", 2)

    def test_stream_cannot_exceed_hard_bound(self):
        with patch.object(scan, "MAX_BYTES", 2), self.assertRaisesRegex(scan.ScanFailure, "download-size-exceeded"):
            scan.copy_bounded([b"abc"], self.root / "download", 2)

    def test_truncated_download_is_error(self):
        with self.assertRaisesRegex(scan.ScanFailure, "download-size-mismatch"):
            scan.copy_bounded([b"ab"], self.root / "download", 3)

    def test_local_symlink_is_rejected(self):
        link = self.root / "link"
        link.symlink_to(self.payload)
        with self.assertRaises(OSError):
            scan.copy_local(link, self.root / "copy")

    def test_local_fifo_is_rejected_without_blocking(self):
        fifo = self.root / "pipe"
        os.mkfifo(fifo)
        with self.assertRaisesRegex(scan.ScanFailure, "not-regular"):
            scan.copy_local(fifo, self.root / "copy")

    def test_signature_freshness_uses_embedded_timestamp_not_mtime(self):
        self.header("daily", self.now - scan.MAX_SIGNATURE_AGE - 1, 28000)
        os.utime(self.db / "daily.cvd", (self.now, self.now))
        result = {}
        with self.assertRaisesRegex(scan.ScanFailure, "stale"):
            scan.database_metadata(result)
        self.assertGreater(result["signature_age_seconds"], scan.MAX_SIGNATURE_AGE)

    def test_signature_age_exact_boundary(self):
        self.header("daily", self.now - scan.MAX_SIGNATURE_AGE, 28000)
        with patch.object(scan.time, "time", return_value=self.now):
            scan.database_metadata({})

    def test_missing_bytecode_database_is_error(self):
        (self.db / "bytecode.cvd").unlink()
        with self.assertRaisesRegex(scan.ScanFailure, "database-bytecode"):
            scan.database_metadata({})

    def test_future_database_is_error(self):
        self.header("daily", self.now + 600, 28000)
        with self.assertRaisesRegex(scan.ScanFailure, "future"):
            scan.database_metadata({})

    def test_missing_database_is_error(self):
        (self.db / "daily.cvd").unlink()
        with self.assertRaisesRegex(scan.ScanFailure, "database-daily"):
            scan.database_metadata({})

    def test_ambiguous_database_is_error(self):
        shutil.copyfile(self.db / "daily.cvd", self.db / "daily.cld")
        with self.assertRaisesRegex(scan.ScanFailure, "unsigned-cld-cache:daily.cld"):
            scan.database_metadata({})

    def test_malformed_database_is_error(self):
        (self.db / "daily.cvd").write_bytes(b"not a CVD")
        with self.assertRaisesRegex(scan.ScanFailure, "invalid-database-header"):
            scan.database_metadata({})

    def test_clean_requires_positive_scan_output(self):
        result, command = self.run_scan()
        self.assertEqual(result["verdict"], "No threats found")
        self.assertEqual([c.args[1] for c in command.call_args_list], [10, 60, 60, 60, 180])

    def test_each_cvd_is_verified_before_payload_scan(self):
        result, command = self.run_scan()
        calls = command.call_args_list
        self.assertEqual([call.args[0] for call in calls[1:4]],
                         [["sigtool", f"--info={self.db / name}"] for name in scan.SIGNED_DATABASES])
        self.assertTrue(result["signature_integrity_verified"])
        self.assertEqual(result["verified_signature_files"], list(scan.SIGNED_DATABASES))
        self.assertIn("--max-files=10000", calls[-1].args[0])

    def test_failed_or_missing_cvd_verification_prevents_native_scan(self):
        for code, text in [(1, "Verification failed.\n"), (0, "Header only\n"),
                           (1, "Verification OK.\n"), (0, "Not Verification OK.\n")]:
            with self.subTest(code=code, text=text):
                result = scan.new_result()
                outputs = [self.process(0, "ClamAV 1.4.6"), self.process(code, text)]
                with patch.object(scan, "command", side_effect=outputs) as command, \
                     self.assertRaisesRegex(scan.ScanFailure, "signature-verification-failed:main"):
                    scan.scan_file(self.payload, self.root, result)
                self.assertEqual(command.call_count, 2)
                self.assertFalse(result["signature_integrity_verified"])
                self.assertEqual(result["verdict"], "Error")

    def test_real_sigtool_rejects_unsigned_cvd_fixture(self):
        with self.assertRaisesRegex(scan.ScanFailure, "signature-verification-failed:main"):
            scan.verify_databases(self.db)

    def test_sigtool_timeout_prevents_payload_scan(self):
        outputs = [self.process(0, "ClamAV 1.4.6"), subprocess.TimeoutExpired("sigtool", 60)]
        with patch.object(scan, "command", side_effect=outputs) as command, self.assertRaises(subprocess.TimeoutExpired):
            scan.scan_file(self.payload, self.root, scan.new_result())
        self.assertEqual(command.call_count, 2)

    def test_local_extra_database_file_is_rejected(self):
        (self.db / "custom.ldb").write_bytes(b"not trusted")
        with self.assertRaisesRegex(scan.ScanFailure, "unexpected-signature-file:custom.ldb"):
            scan.database_metadata({})

    def test_integrity_failure_is_persisted_as_error(self):
        client = self.client()
        code, result = self.main(client, scanner=scan.ScanFailure("signature-verification-failed:daily"))
        self.assertEqual((code, result["verdict"]), (2, "Error"))
        self.assertEqual(client.tags["gbx-clamav-scan-result"], "Error")

    def test_empty_success_output_is_not_clean(self):
        with self.assertRaisesRegex(scan.ScanFailure, "missing-clean-output"):
            self.run_scan(output="")

    def test_mixed_clean_and_detection_output_is_error(self):
        with self.assertRaisesRegex(scan.ScanFailure, "missing-clean-output"):
            self.run_scan(0, f"{self.payload}: OK\n{self.payload}: Eicar-Signature FOUND\n")

    def test_malware_detected(self):
        result, _ = self.run_scan(1, f"{self.payload}: Eicar-Signature FOUND\n")
        self.assertEqual(result["verdict"], "Malicious")

    def test_error_exit_and_warnings_are_not_clean(self):
        for code, text in [(2, "ERROR"), (-9, ""), (0, f"WARNING: skipped\n{self.payload}: OK\n"),
                           (0, f"LibClamAV Warning: skipped\n{self.payload}: OK\n")]:
            with self.subTest(code=code), self.assertRaisesRegex(scan.ScanFailure, "execution-error"):
                self.run_scan(code, text)

    def test_encrypted_and_exceeded_limits_are_error_not_malicious(self):
        for detection, reason in [("Heuristics.Encrypted.Zip", "encrypted-content"),
                                  ("Heuristics.Limits.Exceeded.MaxFiles", "scan-limit-exceeded"),
                                  ("Heuristics.Broken.Media", "broken-content")]:
            with self.subTest(detection=detection), self.assertRaisesRegex(scan.ScanFailure, reason):
                self.run_scan(1, f"{self.payload}: {detection} FOUND\n")

    def test_scanner_never_runs_freshclam(self):
        result, command = self.run_scan()
        self.assertEqual(result["verdict"], "No threats found")
        self.assertTrue(all(call.args[0][0] in ("clamscan", "sigtool") for call in command.call_args_list))
        self.assertEqual(sum(call.args[0][0] == "sigtool" for call in command.call_args_list), 3)
        self.assertNotIn("refresh_exit_code", result)

    def test_stale_snapshot_fails_before_native_scan(self):
        self.header("daily", self.now - scan.MAX_SIGNATURE_AGE - 3600, 28000)
        with self.assertRaisesRegex(scan.ScanFailure, "stale"):
            self.run_scan()

    def test_genuine_found_precedes_warnings(self):
        result, _ = self.run_scan(1, f"LibClamAV Warning: diagnostic\n{self.payload}: Eicar-Test-Signature FOUND\n")
        self.assertEqual(result["verdict"], "Malicious")

    def test_found_does_not_override_an_error_exit(self):
        with self.assertRaisesRegex(scan.ScanFailure, "execution-error"):
            self.run_scan(2, f"{self.payload}: Eicar-Test-Signature FOUND\n")

    def test_complete_outdated_banner_allows_clean(self):
        result, _ = self.run_scan(0, f"{scan.OUTDATED_BANNER}\n{self.payload}: OK\n")
        self.assertEqual(result["verdict"], "No threats found")
        self.assertTrue(result["engine_outdated"])
        self.assertEqual(result["engine"], "1.4.3 (outdated)")

    def test_outdated_engine_tag_uses_supported_azure_characters(self):
        result, _ = self.run_scan(0, f"{scan.OUTDATED_BANNER}\n{self.payload}: OK\n")
        result.update(sha256="a" * 64, scan_time=scan.utc())
        client = self.client()
        scan.publish(client, result)
        self.assertEqual(client.tags["gbx-clamav-engine"], "1.4.3 outdated")
        self.assertEqual(result["engine"], "1.4.3 (outdated)")
        for value in client.tags.values():
            self.assertRegex(value, r"^[A-Za-z0-9 +./:=_-]*$")

    def test_repeated_complete_outdated_banners_allow_clean(self):
        result, _ = self.run_scan(0, f"{scan.OUTDATED_BANNER}\n{scan.OUTDATED_BANNER}\n{self.payload}: OK\n")
        self.assertEqual(result["verdict"], "No threats found")
        self.assertTrue(result["engine_outdated"])

    def test_partial_or_modified_outdated_banner_is_error(self):
        for banner in [scan.OUTDATED_BANNER.rsplit("\n", 1)[0], scan.OUTDATED_BANNER.replace("Installing.html", "Other.html")]:
            with self.subTest(banner=banner), self.assertRaisesRegex(scan.ScanFailure, "execution-error"):
                self.run_scan(0, f"{banner}\n{self.payload}: OK\n")

    def test_outdated_banner_does_not_hide_other_warning_or_error(self):
        for extra in ["LibClamAV Warning: scan skipped", "ERROR: unable to read"]:
            with self.subTest(extra=extra), self.assertRaisesRegex(scan.ScanFailure, "execution-error"):
                self.run_scan(0, f"{scan.OUTDATED_BANNER}\n{extra}\n{self.payload}: OK\n")

    def test_maxfiles_heuristic_is_error_even_with_warning(self):
        with self.assertRaisesRegex(scan.ScanFailure, "scan-limit-exceeded"):
            self.run_scan(1, f"WARNING: diagnostic\n{self.payload}: Heuristics.Limits.Exceeded.MaxFiles FOUND\n")

    def test_skip_without_warning_never_means_clean(self):
        with self.assertRaisesRegex(scan.ScanFailure, "missing-clean-output"):
            self.run_scan(0, f"{self.payload}: SKIPPED\n{self.payload}: OK\n")

    def test_poison_invalidates_and_writes_error_without_reading_bytes(self):
        client = self.client()
        client.tags["gbx-clamav-scan-result"] = "No threats found"
        result = scan.new_result()
        with patch.object(scan, "blob_client", return_value=client), patch.object(scan, "signature_client") as signatures:
            scan.process_scan(result, blob_name="test/document.pdf", force_error="poison-message")
        self.assertEqual(result["verdict"], "Error")
        self.assertEqual(client.tags["gbx-clamav-scan-result"], "Error")
        self.assertEqual(client.tags["gbx-clamav-sha256"], "unavailable")
        self.assertEqual(len(client.tags), 7)
        self.assertTrue(result["tags_written"])
        client.download_blob.assert_not_called()
        signatures.assert_not_called()

    def test_limits_and_alerts_are_explicit(self):
        args = scan.scan_command(self.payload, self.root)
        for required in ["--max-filesize=200000000", "--max-scansize=400000000", "--max-files=10000",
                         "--max-recursion=16", "--max-scantime=120000", "--alert-exceeds-max=yes",
                         "--alert-encrypted=yes", "--alert-broken=yes", "--alert-broken-media=yes",
                         "--bytecode-timeout=1000", "--official-db-only=yes"]:
            self.assertIn(required, args)

    def test_cloud_download_hash_tags_and_etag_precondition(self):
        client = self.client()
        code, result = self.main(client)
        self.assertEqual(code, 0)
        self.assertEqual(client.tags["gbx-clamav-sha256"], hashlib.sha256(b"abc").hexdigest())
        self.assertEqual(client.tags["gbx-clamav-scan-result"], "No threats found")
        self.assertEqual(client.tags["owner"], "preserve-me")
        kwargs = client.download_blob.call_args.kwargs
        self.assertEqual(kwargs["etag"], '"v1"')
        self.assertEqual((kwargs.get("offset"), kwargs.get("length")), (0, 3))
        self.assertEqual(kwargs["max_concurrency"], 1)
        self.assertEqual(kwargs["match_condition"].name, "IfNotModified")
        self.assertNotIn("gbx-clamav-scan-result", client.set_blob_tags.call_args_list[0].args[0])
        self.assertTrue(result["tags_written"])

    def test_changed_blob_cannot_receive_clean_verdict(self):
        client = self.client()
        client.get_blob_properties.side_effect = [SimpleNamespace(size=3, etag='"v1"'), SimpleNamespace(size=3, etag='"v2"')]
        code, result = self.main(client)
        self.assertEqual((code, result["verdict"], result["reason"]), (2, "Error", "blob-changed-during-scan"))
        self.assertEqual(client.tags["gbx-clamav-scan-result"], "Error")

    def test_oversize_cloud_blob_is_never_downloaded(self):
        client = self.client()
        client.get_blob_properties.return_value.size = scan.MAX_BYTES + 1
        code, result = self.main(client)
        self.assertEqual(code, 2)
        client.download_blob.assert_not_called()
        self.assertIsNone(result["sha256"])

    def test_timeout_and_exception_publish_error(self):
        for error in [subprocess.TimeoutExpired("clamscan", 180), ValueError("bad content")]:
            with self.subTest(error=type(error).__name__):
                client = self.client()
                code, result = self.main(client, scanner=error)
                self.assertEqual((code, result["verdict"]), (2, "Error"))
                self.assertEqual(client.tags["gbx-clamav-scan-result"], "Error")

    def test_tag_failure_cannot_log_clean(self):
        client = self.client()
        calls = []
        def write(tags, **kwargs):
            calls.append(tags)
            if tags.get("gbx-clamav-scan-result") == "No threats found":
                raise RuntimeError("write failed")
            client.tags = tags
        client.set_blob_tags.side_effect = write
        code, result = self.main(client)
        self.assertEqual((code, result["verdict"]), (2, "Error"))
        self.assertEqual(client.tags["gbx-clamav-scan-result"], "Error")
        self.assertTrue(result["tags_written"])
        self.assertTrue(any(tags.get("gbx-clamav-scan-result") == "No threats found" for tags in calls))

    def test_unreachable_storage_is_reported_without_claiming_tags_written(self):
        client = self.client()
        client.get_blob_tags.side_effect = RuntimeError("unreachable")
        code, result = self.main(client)
        self.assertEqual((code, result["verdict"], result["tags_written"]), (2, "Error", False))

    def test_full_tag_map_invalidates_existing_clean_verdict(self):
        client = self.client()
        client.tags = {**{f"other-{i}": "x" for i in range(9)}, "gbx-clamav-scan-result": "No threats found"}
        code, result = self.main(client)
        self.assertEqual((code, result["verdict"]), (2, "Error"))
        self.assertEqual(len(client.tags), 10)
        self.assertEqual(client.tags["gbx-clamav-scan-result"], "Error")
        self.assertNotIn("gbx-clamav-sha256", client.tags)
        client.download_blob.assert_not_called()

    def test_explicit_empty_blob_does_not_consume_a_queue_message(self):
        output = io.StringIO()
        with patch.object(scan, "queue_client") as queue, contextlib.redirect_stdout(output):
            code = scan.main(["--blob-name", ""])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(output.getvalue())["reason"], "invalid-blob-name")
        queue.assert_not_called()

    def test_invalid_cli_emits_one_error_json(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = scan.main(["--bogus"])
        self.assertEqual(code, 2)
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertEqual(json.loads(output.getvalue())["verdict"], "Error")


if __name__ == "__main__":
    unittest.main()
