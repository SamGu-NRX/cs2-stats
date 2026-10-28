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
///
/// There is one no-GC region per process, so two tests measuring at once take turns, and a span that
/// finds the region taken reads inexactly. Run in parallel with the other measuring classes on CI's
/// runner, RecorderTests once read only 32 of its 100 sampled ticks exactly; locally, a span that found the
/// region taken was the only inexact exact-request seen, and a test holding it in 1 ms spans alongside
/// RecorderTests leaves it none. Every class that uses this
/// meter is therefore in the <see cref="Collection"/> collection, which xUnit runs on its own after the
/// parallel ones: no other test holds the region, allocates or collects while a span is measured.
/// </summary>
internal struct AllocMeter
{
    /// <summary>The xUnit collection of every test class that uses AllocMeter (<see cref="AllocationCollection"/>).</summary>
    public const string Collection = "Allocation measurement";

    /// <summary>The most a pause can add to a reading: one allocation context, 8 KB on 64-bit .NET.</summary>
    public const long PausedSlack = 8 * 1024;

    // room for every thread's allocations during one span; more ends the region and the reading is lost
    private const long NoGcBudget = 16 * 1024 * 1024;
    // one no-GC region per process; the collection keeps measuring tests apart, and the lock still guards it
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

/// <summary>Runs the test classes that measure allocations on their own, after every parallel test (<see cref="AllocMeter"/>).</summary>
[CollectionDefinition(AllocMeter.Collection, DisableParallelization = true)]
public sealed class AllocationCollection { }
