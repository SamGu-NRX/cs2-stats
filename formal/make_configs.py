"""Regenerate the focused, checked-in TLC bounds. Standard library only."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def config(name, constants, invariants, properties=(), spec="Spec"):
    def value(v):
        if isinstance(v, bool):
            return str(v).upper()
        if isinstance(v, str):
            return '"' + v + '"'
        return str(v)
    lines = ["SPECIFICATION " + spec, "CONSTANTS"]
    lines += [f"{k} = {value(v)}" for k, v in constants.items()]
    if invariants:
        lines += ["INVARIANTS", *invariants]
    if properties:
        lines += ["PROPERTIES", *properties]
    (ROOT / (name + ".cfg")).write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    base = dict(Writers=1, Pruners=1, Initial="live", Reader="none", Retry=False,
                Failures=False, Crashes=False, Retirement=False, ManualDelete=False, PruneLimit=1)
    def publish(name, inv, prop=(), fair=False, **kw):
        config("Publish" + name, base | kw, ["TypeOK", *inv], prop,
               "FairSpec" if fair else "Spec")
    publish("CurrentRace", ["CurrentValid"])
    publish("Crash", ["CrashAvailable"], Crashes=True)
    publish("CrashSerial", ["CrashAvailable"], Crashes=True, Pruners=0)
    publish("FreshCrash", ["CrashAvailable"], Initial="fresh", Crashes=True, Pruners=0)
    publish("RetireRace", ["NoResurrection"], Retirement=True)
    publish("RetiredCrash", ["CrashAvailable"], Writers=0,Initial="replaced",Crashes=True)
    publish("StrictWithdrawal", ["StrictWithdrawal"], Initial="stale: reason", Pruners=0)
    for marker, suffix in [("stale: reason","Stale"),("unreadable","Unreadable"),
                           ("unknown","Unknown"),("empty","Empty"),("replaced","Replaced")]:
        publish(suffix, ["StaleKept"], Initial=marker, Failures=True, Crashes=True)
    publish("TwoWriters", ["NoMix", "StaleKept"], Writers=2, Pruners=1, Reader="rating")
    publish("Retry", ["NoMix", "StaleKept"], Writers=2, Retry=True, Failures=True, Reader="rating")
    publish("TwoPruners", ["NoMix", "StaleKept"], Writers=1, Pruners=2, Reader="python")
    for reader, suffix in [("python","Python"),("node","Node"),("rating","Rating")]:
        publish(suffix, ["NoMix", "StaleKept"], Reader=reader, Failures=True)
        publish(suffix + "Incomplete", ["NoIncomplete"], Reader=reader)
    publish("NodePerFile", ["NoMix"], Reader="node-per-file")
    publish("RatingRetryExhausted", ["ReaderSucceeds"], Writers=2, Reader="rating", Pruners=0)
    publish("RatingResolveError", ["ReaderSucceeds"], Reader="rating")
    publish("RatingBinding", ["RatingBindsTarget"], Reader="rating", Pruners=0)
    publish("Manual", ["CrashAvailable"], ManualDelete=True, Crashes=True)
    publish("PruneLive", [], ["OldEventuallyPruned"], fair=True,
            Initial="garbage", PruneLimit=0)
    publish("PruneOneShot", [], ["OldEventuallyPruned"], fair=True,
            Initial="garbage", PruneLimit=1)
    publish("PruneDangling", [], ["OldEventuallyPruned"], fair=True,
            Initial="garbage", ManualDelete=True, PruneLimit=0)
    gate = dict(Maps=2, Reloads=2, Hot=False, AtMatch=False, OrderedEnd=True,
                AccurateName=True, EndThrows=False,ReloadDuringEnd=False)
    for name, options in [("Cold",{}),("HotMenu",dict(Hot=True)),
                          ("HotMatch",dict(Hot=True,AtMatch=True))]:
        config("MapGate" + name, gate | options,
               ["TypeOK","NoMenuEntities","GateSound","InitializedSound"],
               ["EventuallyOpen","EventuallyInit"])
    config("MapGateLateEnd", gate | dict(OrderedEnd=False), ["NoMenuEntities"])
    config("MapGateStaleName", gate | dict(AccurateName=False,Hot=True), ["NoMenuEntities"])
    config("MapGateEndThrows", gate | dict(EndThrows=True), ["NoMenuEntities"])
    config("MapGateReloadDuringEnd", gate | dict(ReloadDuringEnd=True), ["NoMenuEntities"])
    plugin = dict(Maps=2,Captures=3,Rounds=2,OrderedRounds=True,Reloads=0,MidRound=False)
    config("PluginSafety", plugin, ["TypeOK","NoMenuTrace","FailureSticky",
           "NoVisibleWhenOff","FailureRecorded","LiveSourceRecorded","CaptureSound","NoPostFinalizeLive","NoDoubleSeal"])
    config("PluginLateFreeze", plugin | dict(OrderedRounds=False), ["NoPostFinalizeLive"])
    config("PluginAfterWin", plugin, ["NoCaptureAfterWin"])
    config("PluginHotReload", plugin | dict(Reloads=1), ["FailureSticky"])
    config("PluginMidRoundError", plugin | dict(MidRound=True), ["FailureRecorded"])
    config("PluginMidRoundSource", plugin | dict(MidRound=True), ["LiveSourceRecorded"])
    pipeline = dict(Invalidated=False,Collision=False,RefeedDone=False,TornQueue=False,Crashes=True)
    config("PipelineSafety", pipeline, ["TypeOK","ReplacementBeforeDelete","StaleKept","CrashQueuePreserved"])
    config("PipelineLostReplacement", pipeline | dict(Invalidated=True), ["ReplacementBeforeDelete"])
    config("PipelineIdentity", pipeline | dict(Collision=True), ["ReplacementBeforeDelete"])
    config("PipelineQueueCrash", pipeline | dict(TornQueue=True), ["CrashQueuePreserved"])
    config("PipelineRefeed", pipeline | dict(RefeedDone=True,Crashes=False), [],
           ["RefeedEventuallyProcessed"], "FairSpec")


if __name__ == "__main__":
    main()
