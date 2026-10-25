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
        g.ServerTick();
        Assert.False(g.MapRunning);
        g.MapStarted();
        Assert.True(g.MapRunning);
        g.MapEnded();
        g.ServerTick(); // a tick between maps does not reopen it
        Assert.False(g.MapRunning);
    }

    /// <summary>Fails if a hot reload touches entities before a server tick shows a map is running, or never resumes.</summary>
    [Fact]
    public void HotReloadWaitsForTheFirstServerTick()
    {
        var g = new MapGate();
        g.PluginLoaded(hotReload: true);
        Assert.False(g.MapRunning);
        g.ServerTick();
        Assert.True(g.MapRunning);
    }
}
