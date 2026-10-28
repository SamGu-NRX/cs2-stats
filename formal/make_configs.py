"""Regenerate the focused, checked-in TLC bounds. Standard library only."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class Model(str):
    """A TLC model value: written bare, not quoted."""


def config(name, constants, invariants, properties=(), spec="Spec", symmetry=None):
    def value(v):
        if isinstance(v, bool):
            return str(v).upper()
        if isinstance(v, Model):
            return str(v)
        if isinstance(v, str):
            return '"' + v + '"'
        if isinstance(v, (set, frozenset)):
            return "{" + ", ".join(value(x) for x in sorted(v)) + "}"
        return str(v)
    lines = ["SPECIFICATION " + spec, "CONSTANTS"]
    lines += [f"{k} = {value(v)}" for k, v in constants.items()]
    if symmetry:
        lines += ["SYMMETRY " + symmetry]
    if invariants:
        lines += ["INVARIANTS", *invariants]
    if properties:
        lines += ["PROPERTIES", *properties]
    (ROOT / (name + ".cfg")).write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    base = dict(Writers=1, Pruners=1, Initial="live", Reader="none", Retry=False,
                Failures=False, Crashes=False, Retirement=False, ManualDelete=False, PruneLimit=1,
                Fixed=True, StaleActor=False)
    def publish(name, inv, prop=(), fair=False, **kw):
        config("Publish" + name, base | kw, ["TypeOK", *inv], prop,
               "FairSpec" if fair else "Spec")
    publish("CurrentRace", ["CurrentValid", "LockDiscipline"])
    publish("Crash", ["CrashAvailable"], Crashes=True)
    publish("CrashSerial", ["CrashAvailable"], Crashes=True, Pruners=0)
    publish("FreshCrash", ["CrashAvailable"], Initial="fresh", Crashes=True, Pruners=0)
    publish("RetireRace", ["NoResurrection", "LockDiscipline"], Retirement=True)
    publish("RetiredCrash", ["CrashAvailable"], Writers=0,Initial="replaced",Crashes=True)
    publish("StaleConcurrent", ["NoResurrection", "StaleKept"], StaleActor=True)
    publish("StrictWithdrawal", ["StrictWithdrawal"], Initial="stale: reason", Pruners=0)
    for marker, suffix in [("stale: reason","Stale"),("unreadable","Unreadable"),
                           ("unknown","Unknown"),("empty","Empty"),("replaced","Replaced")]:
        publish(suffix, ["StaleKept"], Initial=marker, Failures=True, Crashes=True)
    publish("TwoWriters", ["NoMix", "StaleKept", "LockDiscipline"], Writers=2, Pruners=1, Reader="rating")
    publish("Retry", ["NoMix", "StaleKept", "LockDiscipline"], Writers=2, Retry=True, Failures=True, Reader="rating")
    publish("TwoPruners", ["NoMix", "StaleKept", "LockDiscipline"], Writers=1, Pruners=2, Reader="python")
    for reader, suffix in [("python","Python"),("node","Node"),("rating","Rating")]:
        publish(suffix, ["NoMix", "StaleKept", "LockDiscipline"], Reader=reader, Failures=True)
        publish(suffix + "Incomplete", ["NoIncomplete", "ValidationSnapshot"], Reader=reader)
    publish("NodePerFile", ["NoMix"], ["ReaderEventuallyReturns"], fair=True, Reader="node-per-file")
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
    config("PluginEventGate", plugin, ["NoGatedEvent"])
    pipeline = dict(Invalidated=False,Collision=False,RefeedDone=False,TornQueue=False,Crashes=True,Fixed=True,SameDir=False)
    config("PipelineSafety", pipeline, ["TypeOK","ReplacementBeforeDelete","StaleKept","CrashQueuePreserved"])
    config("PipelineLostReplacement", pipeline | dict(Invalidated=True), ["ReplacementBeforeDelete"])
    config("PipelineIdentity", pipeline | dict(Collision=False), ["ReplacementBeforeDelete"])
    config("PipelineLegacyIdentity", pipeline | dict(Fixed=False, Collision=True), ["ReplacementBeforeDelete"])
    config("PipelineQueueCrash", pipeline | dict(TornQueue=True), ["CrashQueuePreserved"])
    config("PipelineRefeed", pipeline | dict(RefeedDone=True,Crashes=False), [],
           ["RefeedEventuallyProcessed"], "FairSpec")
    config("PipelineSelfRetire", pipeline | dict(SameDir=True,Crashes=False), ["SelfRetirementSafe"])
    config("PipelineInPlaceWrongVersion", pipeline | dict(SameDir=True, Invalidated=True, Crashes=False),
           ["InPlaceVersionSafe"])
    config("PipelineInPlaceOwnVersion", pipeline | dict(SameDir=True, Invalidated=False, Crashes=False),
           ["InPlaceVersionSafe"])
    config("PipelineLegacyInPlace", pipeline | dict(Fixed=False, SameDir=True, Invalidated=True, Crashes=False),
           ["InPlaceVersionSafe"])
    # The clips launch protocol (ClipsLaunch.tla): two launches of one job, at most one instance crash
    # Shipped code: WatcherCheck, WatcherSettles and HlaeCheck all TRUE.
    clips = dict(Instances={"A"}, N=2, Crashes=1, UserSessions=0, SpawnFails=True, PidsFail=True,
                 WatcherCheck=True, WatcherSettles=True, HlaeCheck=True)
    safety = ["TypeOK", "NoTakeWithoutEvidence", "ResultTruthful", "OwnerIsCreator", "OneLaunchAtATime"]
    config("ClipsLaunchSafety", clips, [*safety, "EvidenceKept"])
    config("ClipsLaunchTwoInstances", clips | dict(Instances={"A", "B"}, SpawnFails=False), [*safety, "EvidenceKept"])
    config("ClipsLaunchUserSession", clips | dict(Crashes=0, UserSessions=1), [*safety, "EvidenceKept"])
    config("ClipsLaunchUserSessionSafety", clips | dict(UserSessions=1), safety)
    config("ClipsLaunchCrashGap", clips | dict(SpawnFails=False), ["OneLaunchAtATime"])
    config("ClipsLaunchWide", clips | dict(Instances={"A", "B"}, N=3, UserSessions=1), safety)
    config("ClipsLaunchLegacyHlaeCheck", clips | dict(SpawnFails=False, HlaeCheck=False), ["OneLaunchAtATime"])
    # The pipeline's archive lifecycle (Archive.tla)
    # Shipped code: CheckFirst and all three fixes (LedgerFirst, ExpiryRowFirst, EvictionFixed). Each Legacy
    # configuration turns one of them off and must keep finding the gap it closed.
    archive = dict(Archives={1, 2}, Crashes=1, Redownloads=1, RetryFailed=True, CapPressure=True, FailedPressure=True,
                   WorkerFails=True, CheckFirst=True, LedgerFirst=True, ExpiryRowFirst=True, EvictionFixed=True)
    every = ["TypeOK", "NoUnaccountedDeletion", "ExpiredRecorded", "CapSparesActive", "FailedKept", "DeletedRecorded",
             "EvictedRedownloadable"]
    config("ArchiveSafety", archive, every)
    config("ArchiveEviction", archive | dict(Crashes=0), ["EvictedRedownloadable"])
    config("ArchiveCrashLedger", archive, ["DeletedRecorded"])
    config("ArchiveCrashExpiry", archive, ["ExpiredRecorded"])
    config("ArchiveWide", archive | dict(Archives={Model("a1"), Model("a2"), Model("a3")}, Redownloads=0), every,
           symmetry="Symmetry")
    config("ArchiveLegacyEviction", archive | dict(Crashes=0, EvictionFixed=False), ["EvictedRedownloadable"])
    config("ArchiveLegacyLedgerOrder", archive | dict(LedgerFirst=False), ["DeletedRecorded"])
    config("ArchiveLegacyExpiry", archive | dict(ExpiryRowFirst=False), ["ExpiredRecorded"])
    config("ArchiveLegacyNoCheck", archive | dict(Crashes=0, CheckFirst=False), ["NoUnaccountedDeletion"])
    # the HLAE check now covers this schedule too, so both checks come off to show the watcher check's own case
    config("ClipsLaunchLegacyWatcherCheck", clips | dict(Crashes=0, SpawnFails=False, WatcherCheck=False, HlaeCheck=False),
           ["OneLaunchAtATime"])


if __name__ == "__main__":
    main()
