using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Compression;

namespace BotMatchStats.Core;

public enum MessageLevel { Info, Warn, Error }

/// <summary>A message from the worker, read by the game thread on its next tick.</summary>
public sealed class WorkerMessage
{
    public MessageLevel Level;
    public string Text = "";
    /// <summary>Set when a scan found the in-progress file of the current game; the worker now holds that match.</summary>
    public MatchMeta? Resume;
    /// <summary>Rounds already in the resumed file.</summary>
    public int ResumeRounds;
    public bool ScanDone;
}

/// <summary>
/// Owns the worker thread. The game thread only enqueues: sealed buffers (<see cref="Submit"/>) and
/// scan requests. The worker merges buffers into the match store, encodes JSON, gzips at the
/// fastest level and replaces the file atomically (.tmp then move). The game thread never waits on
/// it except during unload, which drains the queue with a timeout.
/// </summary>
public sealed class MatchWriter : IRecorderSink, IDisposable
{
    private sealed class Work
    {
        public WriteJob? Job;
        public string? ScanMap;
        public float ScanGameStart;
        public ManualResetEventSlim? Barrier;
    }

    private readonly string _root;
    private readonly string? _gameDir;
    private readonly BlockingCollection<Work> _queue = new(new ConcurrentQueue<Work>());
    private readonly ConcurrentQueue<RoundBuffer> _pool = new();
    private readonly Thread _thread;
    private MatchStore _store = new();
    private MatchStore _scratch = new();
    private string? _gameVersion;
    private bool _gameVersionRead;
    private int _bufferMisses;
    /// <summary>Buffers created on the worker at start, so the game thread normally never allocates one.</summary>
    public const int PrewarmBuffers = 3;

    public ConcurrentQueue<WorkerMessage> Messages { get; } = new();
    public string InProgressDir => Path.Combine(_root, "inprogress");
    public string MatchesDir => Path.Combine(_root, "matches");
    /// <summary>Times the game thread found the pool empty and had to allocate a buffer itself.</summary>
    public int BufferMisses => Volatile.Read(ref _bufferMisses);

    public MatchWriter(string root, string? gameDir)
    {
        _root = root;
        _gameDir = gameDir;
        // Below-normal priority: the game client often runs on the same machine.
        _thread = new Thread(Run) { IsBackground = true, Name = "BotMatchStats writer", Priority = ThreadPriority.BelowNormal };
        _thread.Start();
    }

    public RoundBuffer Rent()
    {
        if (_pool.TryDequeue(out var b)) return b;
        Interlocked.Increment(ref _bufferMisses);
        return new RoundBuffer();
    }

    public void Submit(WriteJob job) => _queue.Add(new Work { Job = job });

    /// <summary>
    /// Finds the in-progress file for (map, gameStart) and loads it for resuming; every other
    /// in-progress file is written out as an abandoned match.
    /// </summary>
    public void RequestScan(string map, float gameStart) => _queue.Add(new Work { ScanMap = map, ScanGameStart = gameStart });

    /// <summary>Blocks until queued work is done or the timeout passes. Returns false on timeout.</summary>
    public bool Drain(TimeSpan timeout)
    {
        if (_queue.IsAddingCompleted) return true;
        using var ev = new ManualResetEventSlim(false);
        _queue.Add(new Work { Barrier = ev });
        return ev.Wait(timeout);
    }

    public void Dispose()
    {
        if (!_queue.IsAddingCompleted) _queue.CompleteAdding();
        _thread.Join(TimeSpan.FromSeconds(5));
    }

    private void Run()
    {
        // Each buffer is about 0.5 MB (some arrays land on the large object heap); creating them
        // here keeps that cost off the game thread. They are reused for the life of the plugin.
        for (int i = 0; i < PrewarmBuffers; i++) _pool.Enqueue(new RoundBuffer());
        foreach (var w in _queue.GetConsumingEnumerable())
        {
            try
            {
                if (w.Barrier != null) w.Barrier.Set();
                else if (w.Job != null) Write(w.Job);
                else if (w.ScanMap != null) Scan(w.ScanMap, w.ScanGameStart);
            }
            catch (Exception ex)
            {
                Post(MessageLevel.Error, $"Writer failed: {ex}");
            }
        }
    }

    private void Write(WriteJob job)
    {
        if (_store.Meta.Id != job.Meta.Id) _store.Clear();
        if (job.Buffer != null)
        {
            _store.Append(job.Buffer);
            job.Buffer.Clear();
            _pool.Enqueue(job.Buffer);
        }
        _store.Meta = job.Meta;
        FillGameVersion(_store.Meta);

        string inProgress = Path.Combine(InProgressDir, _store.Meta.BaseName + ".json.gz");
        if (job.Kind == JobKind.InProgress)
        {
            WriteFile(_store, inProgress, inProgress: true);
            return;
        }
        if (_store.RoundCount == 0)
        {
            Post(MessageLevel.Info, $"Capture {_store.Meta.Id} ended ({_store.Meta.Status}) with no rounds; nothing written.");
        }
        else
        {
            string dest = Path.Combine(MatchesDir, _store.Meta.Year, _store.Meta.BaseName + ".json.gz");
            WriteFile(_store, dest, inProgress: false);
            Post(MessageLevel.Info, $"Wrote {_store.Meta.Status} match: {dest} ({_store.LastBytes} bytes, {_store.RoundCount} rounds).");
        }
        if (File.Exists(inProgress)) File.Delete(inProgress);
        _store.Clear();
    }

    private void WriteFile(MatchStore s, string dest, bool inProgress)
    {
        var sw = Stopwatch.StartNew();
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        string tmp = dest + ".tmp";
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
        // The per-round rewrite uses the fastest level; the one final write per match uses Optimal.
        // Replay of fixtures/events_two_matches.jsonl (21 rounds): Fastest 84 KB in 4.2 ms,
        // Optimal 52 KB in 5.8 ms (ReplayTests output, worker thread, CS2 running on the same machine).
        using (var gz = new GZipStream(fs, inProgress ? CompressionLevel.Fastest : CompressionLevel.Optimal))
        {
            MatchCodec.Write(s, gz, inProgress);
        }
        File.Move(tmp, dest, overwrite: true);
        sw.Stop();
        s.LastWriteMs = sw.Elapsed.TotalMilliseconds;
        if (s.LastWriteMs > s.MaxWriteMs) s.MaxWriteMs = s.LastWriteMs;
        s.LastBytes = new FileInfo(dest).Length;
    }

    private void Scan(string map, float gameStart)
    {
        bool found = false;
        if (Directory.Exists(InProgressDir))
        {
            foreach (var tmp in Directory.GetFiles(InProgressDir, "*.tmp")) TryDelete(tmp);
            foreach (var file in Directory.GetFiles(InProgressDir, "*.json.gz"))
            {
                try
                {
                    using (var fs = File.OpenRead(file))
                    using (var gz = new GZipStream(fs, CompressionMode.Decompress))
                        MatchCodec.Read(gz, _scratch);
                }
                catch (Exception ex)
                {
                    Post(MessageLevel.Error, $"In-progress file {file} could not be read and was renamed to .bad: {ex.Message}");
                    TryMove(file, file + ".bad");
                    continue;
                }
                var m = _scratch.Meta;
                if (!found && m.Map == map && Math.Abs(m.GameStart - gameStart) < 0.01f)
                {
                    found = true;
                    (_store, _scratch) = (_scratch, _store);
                    _scratch.Clear();
                    Messages.Enqueue(new WorkerMessage { Level = MessageLevel.Info, Text = $"Resuming match {m.Id} from {file} ({_store.RoundCount} rounds).", Resume = m.Clone(), ResumeRounds = _store.RoundCount });
                    continue;
                }
                m.Status = "abandoned";
                m.EndUtc = MatchCodec.IsoUtc(File.GetLastWriteTimeUtc(file));
                if (_scratch.RoundCount > 0)
                {
                    string dest = Path.Combine(MatchesDir, m.Year, m.BaseName + ".json.gz");
                    WriteFile(_scratch, dest, inProgress: false);
                    Post(MessageLevel.Info, $"Stale in-progress match {m.Id} written as abandoned: {dest}");
                }
                TryDelete(file);
                _scratch.Clear();
            }
        }
        Messages.Enqueue(new WorkerMessage { Level = MessageLevel.Info, Text = found ? "Scan done (resume)." : "Scan done (no matching in-progress file).", ScanDone = true });
    }

    private void FillGameVersion(MatchMeta m)
    {
        if (!_gameVersionRead)
        {
            _gameVersionRead = true;
            _gameVersion = ReadPatchVersion(_gameDir);
        }
        m.Env.Game ??= _gameVersion;
    }

    /// <summary>Reads PatchVersion from the game's steam.inf (e.g. 1.41.9.2). Null when the file is not found.</summary>
    public static string? ReadPatchVersion(string? gameDir)
    {
        if (gameDir == null) return null;
        foreach (var candidate in new[] { Path.Combine(gameDir, "steam.inf"), Path.Combine(gameDir, "csgo", "steam.inf") })
        {
            if (!File.Exists(candidate)) continue;
            foreach (var line in File.ReadLines(candidate))
                if (line.StartsWith("PatchVersion=", StringComparison.Ordinal)) return line.Substring(13).Trim();
        }
        return null;
    }

    private void Post(MessageLevel level, string text, MatchMeta? resume = null) =>
        Messages.Enqueue(new WorkerMessage { Level = level, Text = text, Resume = resume });

    private void TryDelete(string path)
    {
        try { File.Delete(path); } catch (IOException ex) { Post(MessageLevel.Warn, $"Could not delete {path}: {ex.Message}"); }
    }

    private void TryMove(string from, string to)
    {
        try { File.Move(from, to, overwrite: true); } catch (IOException ex) { Post(MessageLevel.Warn, $"Could not rename {from}: {ex.Message}"); }
    }
}
