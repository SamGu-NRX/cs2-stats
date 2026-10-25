using BotMatchStats.Core;

namespace BotMatchStats.Tests;

public class WarmupTests
{
    /// <summary>Fails if the scripted capture breaks (a recorder change it does not follow); the warm-up then compiles nothing.</summary>
    [Fact]
    public void WarmupRunsWithoutErrors()
    {
        string? err = null;
        Warmup.Run(e => err = e);
        Assert.Null(err);
    }
}

public class MapGateTests
{
    /// <summary>Fails if entities or traces could be touched at the main menu (the cold-launch failure).</summary>
    [Fact]
    public void ColdLaunchWaitsForMapStart()
    {
        var g = new MapGate();
        g.PluginLoaded(hotReload: false);
        Assert.False(g.AwaitingHotReload); // the map name is not even polled
        g.MapNamed();
        Assert.False(g.MapRunning);
        g.MapStarted(() => { });
        Assert.True(g.MapRunning);
        g.MapEnded(() => { });
        Assert.False(g.MapRunning);
    }

    /// <summary>Fails if a hot reload opens before the server names a map (OnTick also runs at the menu), or never resumes.</summary>
    [Fact]
    public void HotReloadWaitsForAMapName()
    {
        var g = new MapGate();
        g.PluginLoaded(hotReload: true);
        Assert.True(g.AwaitingHotReload);
        Assert.False(g.MapRunning);
        g.MapNamed();
        Assert.True(g.MapRunning);
    }

    /// <summary>Fails if a hot reload at the menu followed by a map end leaves the gate open.</summary>
    [Fact]
    public void AMapEndCancelsAHotReloadWait()
    {
        var g = new MapGate();
        g.PluginLoaded(hotReload: true);
        g.MapEnded(() => { });
        g.MapNamed();
        Assert.False(g.MapRunning);
    }

    /// <summary>
    /// Fails if a map end whose capture write-out throws leaves housekeeping free to read the torn-down
    /// map, or leaves the old scan current (audit counterexample MapGateEndThrows).
    /// </summary>
    [Fact]
    public void AThrowingMapEndStillClosesTheGateAndTheScan()
    {
        var g = new MapGate();
        g.PluginLoaded(hotReload: false);
        g.MapStarted(() => { });
        g.Initialized();
        int gen = g.NewScan();
        Assert.Throws<InvalidOperationException>(() => g.MapEnded(() => throw new InvalidOperationException("EndMatch failed")));
        Assert.False(g.EntitiesReady);
        Assert.True(g.NeedInit);
        Assert.False(g.IsCurrentScan(gen));
    }

    /// <summary>Fails if a map start without a map end lets a scan answer for the old map through.</summary>
    [Fact]
    public void AMapStartWithoutMapEndInvalidatesThePendingScan()
    {
        var g = new MapGate();
        g.PluginLoaded(hotReload: false);
        g.MapStarted(() => { });
        g.Initialized();
        int gen = g.NewScan();
        g.MapStarted(() => { });
        Assert.False(g.IsCurrentScan(gen));
        Assert.True(g.NeedInit);
    }

    /// <summary>Fails if an event handler may read its event (e.Userid and the like) at the menu, before init, or after teardown.</summary>
    [Fact]
    public void HandlersMayReadEventsOnlyOnAnInitializedMap()
    {
        var g = new MapGate();
        bool Any(MapGate x) => x.EventAllowed(EventNeed.Map, true, true) || x.EventAllowed(EventNeed.Capture, true, true) || x.EventAllowed(EventNeed.Round, true, true);
        g.PluginLoaded(hotReload: false);
        Assert.False(Any(g));                                   // main menu
        g.MapStarted(() => { });
        Assert.False(Any(g));                                   // map loading, not initialized
        g.Initialized();
        Assert.True(g.EventAllowed(EventNeed.Map, false, false));
        Assert.False(g.EventAllowed(EventNeed.Capture, false, false));
        Assert.False(g.EventAllowed(EventNeed.Round, true, false));
        Assert.True(g.EventAllowed(EventNeed.Round, true, true));
        Assert.Throws<InvalidOperationException>(() => g.MapEnded(() => throw new InvalidOperationException()));
        Assert.False(Any(g));                                   // teardown, even after a failed write-out
        Assert.True(g.EventAllowed(EventNeed.Nothing, false, false));
    }
}
