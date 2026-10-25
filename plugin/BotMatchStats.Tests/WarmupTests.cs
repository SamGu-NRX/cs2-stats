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
        g.MapStarted();
        Assert.True(g.MapRunning);
        g.MapEnded();
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

    /// <summary>Fails if a hot reload at the menu followed by a map start and end leaves the gate open.</summary>
    [Fact]
    public void AMapEndCancelsAHotReloadWait()
    {
        var g = new MapGate();
        g.PluginLoaded(hotReload: true);
        g.MapEnded();
        g.MapNamed();
        Assert.False(g.MapRunning);
    }
}
