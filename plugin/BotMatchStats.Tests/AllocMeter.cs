namespace BotMatchStats.Tests;

/// <summary>
/// Bytes this thread allocates over a span of code, or null when the reading cannot be trusted.
/// When the runtime pauses every thread during the span (a GC triggered by another thread, such as a
/// test class running in parallel), it retires this thread's allocation context and counts the unused
/// rest of it as allocated. On Linux CI that read 2 to 8 KB on ticks that allocate nothing, at a
/// different tick each run, always with GC.GetTotalPauseDuration grown across the tick; the same ticks
/// read 0 on Windows and when the test runs alone. A span with a pause reports null and is skipped.
/// </summary>
internal readonly struct AllocMeter
{
    private readonly long _bytes;
    private readonly TimeSpan _pause;

    private AllocMeter(long bytes, TimeSpan pause) { _bytes = bytes; _pause = pause; }

    public static AllocMeter Start() => new(GC.GetAllocatedBytesForCurrentThread(), GC.GetTotalPauseDuration());

    public long? Read()
    {
        long bytes = GC.GetAllocatedBytesForCurrentThread() - _bytes;
        return GC.GetTotalPauseDuration() == _pause ? bytes : null;
    }
}
