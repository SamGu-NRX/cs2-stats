"""Run the protocol suite, recognizing intentional counterexamples as results.

Raw TLC logs stay in ignored results/. JSON records exact counts and traces.
This wrapper never treats a syntax/type/runtime error as a counterexample. A configuration in FAIL must
fail, and on the property named there: a model that stops being able to fail, or fails for another reason,
is an unexpected result like any other, and the exit status says so (CI's formal job relies on it).
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
# configuration -> the property its counterexample must violate ("temporal" for a liveness property)
FAIL = {
    "PublishFreshCrash": "CrashAvailable", "PublishRetiredCrash": "CrashAvailable",
    "PublishStrictWithdrawal": "StrictWithdrawal", "PublishRatingResolveError": "ReaderSucceeds",
    "PublishRatingBinding": "RatingBindsTarget", "PublishRatingRetryExhausted": "ReaderSucceeds",
    "PublishManual": "CrashAvailable", "PublishPruneOneShot": "temporal", "PublishPruneDangling": "temporal",
    "PluginLateFreeze": "NoPostFinalizeLive", "PluginAfterWin": "NoCaptureAfterWin", "PluginHotReload": "FailureSticky",
    "PipelineLegacyIdentity": "ReplacementBeforeDelete", "PipelineLegacyInPlace": "InPlaceVersionSafe",
    "ClipsLaunchUserSession": "EvidenceKept", "ClipsLaunchLegacyWatcherCheck": "OneLaunchAtATime",
    "ClipsLaunchLegacyHlaeCheck": "OneLaunchAtATime",
    "ArchiveLegacyNoCheck": "NoUnaccountedDeletion", "ArchiveLegacyLedgerOrder": "DeletedRecorded",
    "ArchiveLegacyExpiry": "ExpiredRecorded", "ArchiveLegacyEviction": "EvictedRedownloadable",
}
MODULES = ("Capture", "Calls", "Publish", "MapGate", "Plugin", "Pipeline", "ClipsLaunch", "Archive")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("configs", nargs="*")
    parser.add_argument("--while-gaming", action="store_true")
    parser.add_argument("--all", action="store_true", help="every configuration, the Capture and Calls ones too")
    args = parser.parse_args()
    prefixes = MODULES if args.all else MODULES[2:]
    configs = args.configs or sorted(p.stem for prefix in prefixes for p in ROOT.glob(prefix + "*.cfg"))
    result_path = ROOT / "results" / "protocol-summary.json"
    results = json.loads(result_path.read_text()) if result_path.exists() else {}
    unexpected = False
    for name in configs:
        command = [sys.executable, "-I", str(ROOT / "run.py"), name]
        if args.while_gaming:
            command.append("--while-gaming")
        process = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, encoding="utf-8", errors="replace")
        output = process.stdout
        violated = re.search(r"Invariant (\w+) is violated|Temporal properties were violated", output)
        passed = process.returncode == 0 and "No error has been found" in output
        counts = re.findall(r"([\d,]+) states generated, ([\d,]+) distinct states found", output)
        result = {"result": "PASS" if passed else "COUNTEREXAMPLE" if violated else "ERROR",
                  "generated": int(counts[-1][0].replace(",", "")) if counts else None,
                  "distinct": int(counts[-1][1].replace(",", "")) if counts else None,
                  "expected": "COUNTEREXAMPLE" if name in FAIL else "PASS"}
        module = next(prefix for prefix in MODULES
                      if name.startswith(prefix))
        result["model_sha256"] = hashlib.sha256((ROOT / (module + ".tla")).read_bytes()).hexdigest()
        result["config_sha256"] = hashlib.sha256((ROOT / (name + ".cfg")).read_bytes()).hexdigest()
        if violated:
            result["property"] = violated.group(1) or "temporal"
            result["actions"] = re.findall(r"State \d+: <([^>]+)>", output)
        results[name] = result
        result_path.parent.mkdir(exist_ok=True)
        result_path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
        print(name, json.dumps({k: v for k, v in result.items() if k != "actions"}), flush=True)
        if name in FAIL and result.get("property") not in (None, FAIL[name]):
            result["expected_property"] = FAIL[name]
        if result["result"] != result["expected"] or "expected_property" in result:
            unexpected = True
            print(output[-5000:], flush=True)
    return int(unexpected)


if __name__ == "__main__":
    sys.exit(main())
