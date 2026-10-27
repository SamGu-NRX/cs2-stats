namespace BotMatchStats.Tests;

/// <summary>
/// Bytes this thread allocates over a span of code.
///
/// GC.GetAllocatedBytesForCurrentThread is not exact across a GC pause. When the runtime pauses every
/// thread during the span (a GC triggered by another thread, such as a test class running in parallel),
/// it retires this thread's allocation context and counts the unused rest of it as allocated. On Linux
/// CI that read 2 to 8 KB on ticks that allocate nothing, at a different tick each run, always with
/// GC.GetTotalPauseDuration grown across the tick; the same ticks read 0 on Windows and when the test
/// runs alone. So a reading reports whether a pause spoiled it, and callers hold those readings to
/// <see cref="PausedSlack"/> instead of to zero.
///
/// An exact reading (<see cref="Start(bool)"/> with exact: true) runs the span inside a no-GC region,
/// where no pause can happen, so it is exact whatever other threads do. Starting a region can itself
/// run a GC, so callers take exact readings on a sample of spans only.
/// </summary>
internal struct AllocMeter
{
    /// <summary>The most a pause can add to a reading: one allocation context, 8 KB on 64-bit .NET.</summary>
    public const long PausedSlack = 8 * 1024;

    // room for every thread's allocations during one span; more ends the region and the reading is lost
    private const long NoGcBudget = 16 * 1024 * 1024;
    // one no-GC region per process: tests in parallel take turns, and a test that finds it taken reads inexactly
    private static readonly object RegionLock = new();

    private long _bytes;
    private TimeSpan _pause;
    private bool _region;

    public static AllocMeter Start(bool exact = false)
    {
        var m = new AllocMeter();
        if (exact && Monitor.TryEnter(RegionLock))
        {
            try { m._region = GC.TryStartNoGCRegion(NoGcBudget); }
            catch (InvalidOperationException) { m._region = false; }
            if (!m._region) Monitor.Exit(RegionLock);
        }
        m._pause = GC.GetTotalPauseDuration();
        m._bytes = GC.GetAllocatedBytesForCurrentThread();
        return m;
    }

    /// <summary>The bytes allocated since Start; Paused when a GC pause made them inexact, Exact when a no-GC region held.</summary>
    public (long Bytes, bool Paused, bool Exact) Read()
    {
        long bytes = GC.GetAllocatedBytesForCurrentThread() - _bytes;
        bool paused = GC.GetTotalPauseDuration() != _pause;
        bool exact = false;
        if (_region)
        {
            // EndNoGCRegion throws when a GC ended the region early, so the span was not exact after all
            try { GC.EndNoGCRegion(); exact = !paused; }
            catch (InvalidOperationException) { }
            finally { Monitor.Exit(RegionLock); _region = false; }
        }
        return (bytes, paused, exact);
    }

    /// <summary>
    /// Asserts a span allocated nothing: zero when the reading is exact or no pause touched it, and at most
    /// <see cref="PausedSlack"/> when a GC pause made it inexact (the pause, not the code, accounts for that).
    /// </summary>
    public static void AssertNone((long Bytes, bool Paused, bool Exact) r)
    {
        if (r.Exact || !r.Paused) Xunit.Assert.Equal(0, r.Bytes);
        else Xunit.Assert.InRange(r.Bytes, 0, PausedSlack);
    }
}
