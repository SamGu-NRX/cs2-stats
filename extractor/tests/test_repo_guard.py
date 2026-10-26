"""repo_guard.py, and the extractor's writers that use it: extracted tables, the extraction result, the
Valve import's folder and summary, and the user file, all private, refused anywhere in the repository."""

import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import extract as ex  # noqa: E402
import repo_guard as rg  # noqa: E402
import valve_import as vi  # noqa: E402

REPO = rg.REPO_ROOT
U1 = 76561197960265729


class TestCheckOutput:
    def test_a_private_output_is_refused_anywhere_in_the_repository(self, tmp_path):
        # fails if a private output can land under public/, a source folder, the root, or via .. or case
        repo = tmp_path / "repo"
        (repo / "app" / "public").mkdir(parents=True)
        for p in (repo / "app" / "public" / "x.json", repo / "extractor" / "out", repo / "x.json",
                  tmp_path / "elsewhere" / ".." / "repo" / "y.json", repo):
            with pytest.raises(rg.OutputRefused, match="is private"):
                rg.check_output(p, private=True, what="x", repo=repo)
        if os.name == "nt":
            with pytest.raises(rg.OutputRefused):
                rg.check_output(tmp_path / "REPO" / "APP" / "x.json", private=True, what="x", repo=repo)

    def test_outside_the_repository_anything_goes(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        for p in (tmp_path / "data" / "x.json", tmp_path / "repo-old" / "x.json", tmp_path / "repo2"):
            assert rg.check_output(p, private=True, what="x", repo=repo) == p

    def test_a_public_output_takes_only_its_declared_path_in_the_repository(self, tmp_path):
        repo = tmp_path / "repo"
        own = repo / "model" / "params.json"
        assert rg.check_output(own, private=False, what="params.json", in_repo=own, repo=repo) == own
        with pytest.raises(rg.OutputRefused, match="its only place in the repository is"):
            rg.check_output(repo / "model" / "other.json", private=False, what="params.json", in_repo=own, repo=repo)
        with pytest.raises(rg.OutputRefused, match="it has no place in the repository"):
            rg.check_output(repo / "a.json", private=False, what="a", repo=repo)

    def test_private_json_carries_the_marker_first(self, tmp_path):
        f = rg.write_json(tmp_path / "out" / "r.json", {"a": 1}, private=True, what="r")
        assert list(json.loads(f.read_text(encoding="utf-8"))) == [rg.PRIVATE_KEY, "a"]
        g = rg.write_json(tmp_path / "p.json", {"a": 1}, private=False, what="p")
        assert rg.PRIVATE_KEY not in json.loads(g.read_text(encoding="utf-8"))


class TestExtractor:
    def test_extract_refuses_tables_or_a_result_in_the_repository_before_parsing(self, tmp_path):
        # fails if extract.py can write a map's tables (SteamIDs and names) or its result into the tree
        with pytest.raises(rg.OutputRefused, match="the extracted tables"):
            ex.main(["no.dem", str(REPO / "app" / "public" / "map"), "--source", "local"])
        with pytest.raises(rg.OutputRefused, match="the extraction result"):
            ex.main(["no.dem", str(tmp_path / "map"), "--source", "local", "--result", str(REPO / "result.json")])
        with pytest.raises(rg.OutputRefused):
            ex.write_output({}, REPO / "extractor" / "map", {})

    def test_extract_gets_past_the_guard_outside_the_repository(self, tmp_path):
        # a missing demo fails after the guard, which shows the guard let both paths through
        with pytest.raises(Exception) as e:
            ex.main([str(tmp_path / "no.dem"), str(tmp_path / "map"), "--source", "local", "--result", str(tmp_path / "r.json")])
        assert not isinstance(e.value, rg.OutputRefused)

    def test_the_valve_import_refuses_this_repository_even_where_no_git_folder_marks_it(self, tmp_path, monkeypatch, capsys):
        # fails if the importer's only check is a .git folder: repo_guard refuses the tree by path
        monkeypatch.setattr(vi, "git_work_tree", lambda p: None)
        dem = tmp_path / "a.dem"
        dem.write_bytes(b"demo")
        for args in (["--out", str(REPO / "data")], ["--out", str(tmp_path / "out"), "--result", str(REPO / "summary.json")]):
            with pytest.raises(SystemExit) as e:
                vi.main([str(dem), *args, "--user", str(U1)])
            assert e.value.code == 2 and "refusing to write" in capsys.readouterr().err
        assert not (REPO / "data" / vi.USER_FILE).exists()

    def test_the_user_file_carries_the_private_marker(self, tmp_path):
        vi.resolve_user(tmp_path / "out", None, U1)
        saved = json.loads((tmp_path / "out" / vi.USER_FILE).read_text(encoding="utf-8"))
        assert list(saved) == [rg.PRIVATE_KEY, "steamid", "source"] and saved["steamid"] == U1
        # read back, it is the user, not the marker
        assert vi.resolve_user(tmp_path / "out", None, None) == {"steamid": U1, "source": "--user"}
        with pytest.raises(rg.OutputRefused):
            vi.resolve_user(REPO / "data", None, U1)
