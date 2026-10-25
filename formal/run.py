"""Run a bounded TLC configuration. Only formal/ receives generated files."""
from pathlib import Path
import argparse
import hashlib
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
JAR_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", help="configuration basename, without .cfg")
    parser.add_argument("--while-gaming", action="store_true",
                        help="explicitly allow CS2: one TLC worker, 384 MB heap, below-normal priority")
    args = parser.parse_args()
    name = args.config
    if Path(name).name != name or not (ROOT / (name + ".cfg")).is_file():
        parser.error("config must name an existing .cfg directly inside formal")
    jar = ROOT / "tools" / "tla2tools.jar"
    if not jar.is_file():
        parser.error("download the pinned official tla2tools.jar first; see README.md")
    if hashlib.sha256(jar.read_bytes()).hexdigest() != JAR_SHA256:
        parser.error("tla2tools.jar does not match the pinned release checksum")
    if sys.platform == "win32":
        processes = subprocess.run(
            ["tasklist.exe", "/FI", "IMAGENAME eq cs2.exe", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, check=True,
        ).stdout
        if '"cs2.exe"' in processes.lower() and not args.while_gaming:
            parser.error("CS2 is running. Close it before model checking.")
    modules = ("Capture", "Calls", "Publish", "MapGate", "Plugin", "Pipeline")
    module = next((m for m in modules if name.startswith(m)), None)
    if module is None:
        parser.error("configuration must start with a supported module name: " + ", ".join(modules))
    results = ROOT / "results"
    results.mkdir(exist_ok=True)
    states = ROOT / "states" / name
    temporary = ROOT / "states" / "tmp"
    temporary.mkdir(parents=True, exist_ok=True)
    workers = "1" if args.while_gaming else "4"
    command = ["java", "-Xmx384m" if args.while_gaming else "-Xmx768m",
               "-XX:ActiveProcessorCount=" + workers, "-XX:+UseParallelGC",
               "-Djava.io.tmpdir=" + str(temporary), "-cp", str(jar),
               "tlc2.TLC", "-workers", workers, "-deadlock", "-config", name + ".cfg",
               "-metadir", str(states), module + ".tla"]
    print(" ".join(command), flush=True)
    with (results / (name + ".log")).open("w", encoding="utf-8") as log:
        result = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                creationflags=(subprocess.BELOW_NORMAL_PRIORITY_CLASS
                                               if sys.platform == "win32" and args.while_gaming else 0))
    print((results / (name + ".log")).read_text(encoding="utf-8"))
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
