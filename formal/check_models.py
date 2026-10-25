"""Run the protocol suite, recognizing intentional counterexamples as results.

Raw TLC logs stay in ignored results/. JSON records exact counts and traces.
This wrapper never treats a syntax/type/runtime error as a counterexample.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
FAIL = {
    "PublishCurrentRace", "PublishCrash", "PublishFreshCrash", "PublishRetireRace",
    "PublishStrictWithdrawal", "PublishRetiredCrash", "PublishNodePerFile",
    "PublishPythonIncomplete", "PublishNodeIncomplete",
    "PublishRatingIncomplete", "PublishRatingRetryExhausted", "PublishRatingResolveError",
    "PublishRatingBinding", "PublishManual",
    "PublishPruneOneShot", "PublishPruneDangling", "MapGateLateEnd",
    "MapGateStaleName", "MapGateEndThrows", "MapGateReloadDuringEnd", "PluginLateFreeze", "PluginAfterWin",
    "PluginHotReload", "PluginMidRoundError", "PluginMidRoundSource",
    "PipelineLostReplacement", "PipelineIdentity", "PipelineQueueCrash", "PipelineRefeed",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("configs", nargs="*")
    parser.add_argument("--while-gaming", action="store_true")
    args = parser.parse_args()
    configs = args.configs or sorted(p.stem for prefix in ("Publish", "MapGate", "Plugin", "Pipeline")
                                    for p in ROOT.glob(prefix + "*.cfg"))
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
        module = next(prefix for prefix in ("Capture","Calls","Publish","MapGate","Plugin","Pipeline")
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
        if result["result"] != result["expected"]:
            unexpected = True
            print(output[-5000:], flush=True)
    return int(unexpected)


if __name__ == "__main__":
    sys.exit(main())
