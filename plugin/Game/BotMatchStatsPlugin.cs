using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using BotMatchStats.Core;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Events;
using CounterStrikeSharp.API.Modules.Memory;
using CounterStrikeSharp.API.Modules.Timers;
using Microsoft.Extensions.Logging;

namespace BotMatchStats.Game;

/// <summary>
/// Records bot matches to %APPDATA%\BotMatchStats per SCHEMA.md. This class translates engine state
/// into calls on <see cref="Recorder"/>; the recording logic itself lives in Core and has no engine
/// dependency. Disk work happens on <see cref="MatchWriter"/>'s thread.
/// </summary>
public sealed partial class BotMatchStatsPlugin : BasePlugin
{
    public override string ModuleName => "BotMatchStats";
    public override string ModuleVersion => "1.1.0";
    public override string ModuleDescription => "Records bot matches into compact columnar files";

    private const int MaxSlots = 64;

    private struct Slot
    {
        public nint Ctrl;
        public uint Handle;
        public bool Valid, Pending, IsBot;
        public int Pi, Team;
        public ulong SteamId;
        public string? Key, Name;
        /// <summary>Grenades held at the last once-a-second snapshot.</summary>
        public UtilCounts Util;
        public UtilCounts DeathUtil;
        public int DeathUtilTick, DeathWeapons;
        /// <summary>Equipment value read in the player_death pre-hook, before the victim drops anything.</summary>
        public int DeathEquip, DeathEquipTick;
    }

    private readonly Slot[] _slots = new Slot[MaxSlots];
    private readonly int[] _piSlot = new int[Limits.MaxPlayers];
    private readonly FrameSet _frames = new();
    private readonly PerfCounter _perf = new();
    private readonly GameRoundStats[] _gameStats = new GameRoundStats[Limits.MaxPlayers];
    private readonly bool[] _haveStats = new bool[Limits.MaxPlayers];
    /// <summary>Ammo slot per UtilType, learned from a grenade's VData the first time one is bought or thrown.</summary>
    private readonly int[] _ammoSlot = { -1, -1, -1, -1, -1, -1 };

    private MatchWriter? _writer;
    private Recorder? _rec;
    private CCSGameRules? _rules;
    private CCSTeam? _teamT, _teamCt;
    private bool _disabled, _memReady;
    /// <summary>No entity read or trace until this says a map is running (see <see cref="MapGate"/>).</summary>
    private readonly MapGate _mapGate = new();
    private int _tick, _nextRefresh, _finalizeAt = Nil.V, _matchEndAt = Nil.V, _humanSlot = -1;
    private int _perRoundStride;
    // Scan generations live in _mapGate (see Lifecycle.AcceptResume): answers with another generation
    // are ignored. _scanGameStart/_scanRounds are the game identity the scan was for.
    private float _scanGameStart;
    private int _scanRounds;
    /// <summary>cs_win_panel_match fired on this map, even while capture was unavailable.</summary>
    private bool _winPanelSeen;
    private string _map = "";
    private int _tickErrors;

    // Shot path: the weapon is resolved once per weapon switch, keyed by the active weapon handle.
    private uint _shotWeaponHandle = Mem.InvalidHandle;
    private int _shotWeapon = Nil.V, _shotMaxSpeed = Nil.V, _shotClass = Nil.V;
    private bool _shotIsBullet;

    // Equipment value. The pawn's m_unCurrentEquipmentValue is the first choice; when every bot reads 0
    // at freeze end it is not trusted and values are rebuilt from inventory instead (see InventoryValue).
    private bool _equipFromInventory;
    private readonly Dictionary<ulong, int> _priceByName = new();
    // CS2 store prices, not read from the game: kevlar $650, kevlar + helmet $1000, defuse kit $400.
    private const int KevlarPrice = 650, KevlarHelmetPrice = 1000, DefuserPrice = 400;

    public override void Load(bool hotReload)
    {
        string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "BotMatchStats");
        string? gameDir = null;
        try { gameDir = Server.GameDirectory; } catch (Exception ex) { Logger.LogWarning("Game directory unavailable, env.game will be null: {Message}", ex.Message); }
        _writer = new MatchWriter(root, gameDir);
        _rec = new Recorder(_writer, _frames, _perf, Warn);
        Array.Fill(_piSlot, -1);
        StartCoreWarmup();
        _mapGate.PluginLoaded(hotReload);

        RegisterListener<Listeners.OnTick>(OnTick);
        // Everything that can allocate (worker messages, init, slot refresh, economy, round finalization)
        // runs here, four times a second, so the OnTick handler itself stays allocation-free.
        AddTimer(0.25f, Housekeeping, TimerFlags.REPEAT);
        RegisterListener<Listeners.OnMapStart>(OnMapStart);
        RegisterListener<Listeners.OnMapEnd>(OnMapEnd);

        On<EventRoundStart>(OnRoundStart, EventNeed.Map);
        On<EventRoundFreezeEnd>(OnFreezeEnd, EventNeed.Round);
        On<EventRoundEnd>(OnRoundEnd, EventNeed.Round);
        On<EventCsWinPanelMatch>(OnWinPanel, EventNeed.Nothing);
        On<EventPlayerDeath>(OnDeathPre, EventNeed.Round, HookMode.Pre);
        On<EventPlayerDeath>(OnDeath, EventNeed.Round);
        On<EventPlayerHurt>(OnHurt, EventNeed.Round);
        On<EventPlayerBlind>(OnBlind, EventNeed.Round);
        On<EventWeaponFire>(OnWeaponFire, EventNeed.Round);
        On<EventBulletImpact>(OnBulletImpact, EventNeed.Round);
        On<EventGrenadeThrown>(OnGrenadeThrown, EventNeed.Round);
        On<EventHegrenadeDetonate>(e => Detonation(e.Userid, GrenadeType.He, e.X, e.Y, e.Z, "hegrenade_detonate"), EventNeed.Round);
        On<EventFlashbangDetonate>(e => Detonation(e.Userid, GrenadeType.Flash, e.X, e.Y, e.Z, "flashbang_detonate"), EventNeed.Round);
        On<EventSmokegrenadeDetonate>(e => Detonation(e.Userid, GrenadeType.Smoke, e.X, e.Y, e.Z, "smokegrenade_detonate", e.Entityid), EventNeed.Round);
        On<EventSmokegrenadeExpired>(OnSmokeExpired, EventNeed.Round);
        On<EventInfernoStartburn>(OnInferno, EventNeed.Round);
        On<EventDecoyStarted>(e => Detonation(e.Userid, GrenadeType.Decoy, e.X, e.Y, e.Z, "decoy_started"), EventNeed.Round);
        On<EventBombPlanted>(OnBombPlanted, EventNeed.Round);
        On<EventBombDefused>(OnBombDefused, EventNeed.Round);
        On<EventItemPurchase>(OnItemPurchase, EventNeed.Round);
        On<EventPlayerSpawn>(OnPlayerSpawn, EventNeed.Capture);
        On<EventPlayerTeam>(OnPlayerTeam, EventNeed.Nothing);
        On<EventPlayerDisconnect>(OnPlayerDisconnect, EventNeed.Map);
        Logger.LogInformation("BotMatchStats loaded (hotReload={HotReload}); files go to {Root}", hotReload, root);
    }

    public override void Unload(bool hotReload)
    {
        // CSSharp removes listeners and event handlers itself. Seal what this round has so far so a
        // hot-reloaded instance can resume, then stop the worker.
        try
        {
            FlushLogs();
            if (_rec is { Capturing: true }) _rec.Flush();
            if (_writer != null && !_writer.Drain(TimeSpan.FromSeconds(2)))
                Logger.LogWarning("BotMatchStats: writer did not finish within 2 s during unload; the last write may be missing.");
        }
        finally
        {
            _writer?.Dispose();
            _writer = null;
        }
    }

    private void Warn(string message) => Log(LogLevel.Warning, message);

    // ---- per tick -------------------------------------------------------------------------------

    private void OnTick()
    {
        long t0 = Stopwatch.GetTimestamp();
        long a0 = GC.GetAllocatedBytesForCurrentThread();
        try
        {
            TickBody();
        }
        catch (Exception ex)
        {
            if (_tickErrors++ < 5) Log(LogLevel.Error, $"tick failed: {ex}");
        }
        _perf.Tick(Stopwatch.GetTimestamp() - t0, GC.GetAllocatedBytesForCurrentThread() - a0);
    }

    /// <summary>
    /// The per-tick path: raw pawn reads into frames, then <see cref="Recorder.Tick"/>. Allocation-free in
    /// the steady state; housekeeping that can allocate runs in <see cref="Housekeeping"/>.
    /// </summary>
    private void TickBody()
    {
        if (_disabled || _rec == null || !_mapGate.EntitiesReady) return;
        if (!_rec.Capturing || !_rec.Live) return;
        _tick = Server.TickCount;

        bool aim = _rec.NeedsAim, humanPos = _rec.HumanPosDue(_tick), botPos = _rec.BotPosDue(_tick), ct = _rec.CtSetupDue(_tick);
        if (!aim && !humanPos && !botPos && !ct) return;
        int human = _rec.HumanPi;
        int humanTeam = _humanSlot >= 0 ? _slots[_humanSlot].Team : 0;
        for (int i = 0; i < _frames.ActiveCount; i++)
        {
            int pi = _frames.Active[i];
            int slot = _piSlot[pi];
            if (slot < 0) continue;
            int team = _slots[slot].Team;
            bool isHuman = pi == human;
            bool enemy = aim && IsOpposing(team, humanTeam);
            if (!(botPos || ct || enemy || (isHuman && (aim || humanPos)))) continue;
            bool place = botPos || (isHuman && humanPos) || (ct && team == 3);
            ReadFrame(slot, ref _frames.ByPi[pi], place);
        }
        if (aim && _losProbe != null && _humanSlot >= 0) _losProbe.SetIgnore(PawnOfSlot(_humanSlot));
        _rec.Tick(_tick);
    }

    private static bool IsOpposing(int a, int b) => (a == 2 && b == 3) || (a == 3 && b == 2);

    private void Housekeeping()
    {
        // Queued log lines are written outside live rounds, timed under their own name.
        if (_logQueue.Count > 0 && _rec is not { Live: true })
        {
            EvBegin();
            FlushLogs();
            EvEnd("log");
        }
        EvBegin();
        try
        {
            DrainMessages();
            if (_disabled || _rec == null) return;
            if (!_mapGate.EntitiesReady)
            {
                // Server.MapName reads the game server's globals and returns null when there is no game
                // server (CounterStrikeSharp 1.0.378 natives_engine.cpp GetMapName, globals.cpp
                // getGlobalVars); it never touches the entity system, so it is safe at the main menu.
                if (_mapGate.AwaitingHotReload && !string.IsNullOrEmpty(Server.MapName)) _mapGate.MapNamed();
                if (_mapGate.MapRunning && EntityListReady()) TryInit();
                return;
            }
            _tick = Server.TickCount;
            if (_finalizeAt != Nil.V && _tick >= _finalizeAt) { _finalizeAt = Nil.V; FinalizeRound(); }
            if (_matchEndAt != Nil.V && _tick >= _matchEndAt) { _matchEndAt = Nil.V; EndMatch(); }
            if (_tick >= _nextRefresh)
            {
                _nextRefresh = _tick + 64;
                RefreshSlots(false);
                if (_rec.Capturing) RefreshEconomy();
            }
        }
        catch (Exception ex)
        {
            if (_tickErrors++ < 5) Log(LogLevel.Error, $"housekeeping failed: {ex}");
        }
        finally
        {
            EvEnd("housekeeping");
        }
        // Outside live rounds only, each timed under its own name so a perf row shows what it cost.
        if (_rec is { Live: false } && _mapGate.EntitiesReady && !_disabled)
        {
            EvBegin();
            try { WarmStep(); } catch (Exception ex) { Log(LogLevel.Warning, $"warm-up step failed: {ex.Message}"); }
            EvEnd("warmup");
        }
    }

    /// <summary>Equipment value from the source chosen at this round's freeze end; Nil when unreadable.</summary>
    private int EquipOf(nint pawn) => _equipFromInventory ? InventoryValue(pawn) : Mem.EquipValue(pawn);

    /// <summary>
    /// Equipment value rebuilt from what the pawn holds: each weapon's VData price (cached per designer
    /// name; a wrapper is created only the first time a weapon type is seen), times the count for
    /// stacked grenades, plus armor and defuser at store prices. Approximation: the game's own value
    /// may treat damaged armor differently. Called from events and housekeeping, never per tick.
    /// </summary>
    private int InventoryValue(nint pawn)
    {
        Span<nint> weapons = stackalloc nint[64];
        int n = Mem.Weapons(pawn, weapons);
        if (n < 0) return Nil.V;
        int total = 0;
        for (int i = 0; i < n; i++)
        {
            nint w = weapons[i];
            ulong h = Mem.DesignerNameHash(w);
            if (h == 0) continue;
            if (!_priceByName.TryGetValue(h, out int price))
            {
                price = new CCSWeaponBase(w).VData?.Price ?? 0;
                _priceByName[h] = price;
            }
            int t = Mem.UtilTypeOf(w);
            total += price * (t >= 0 ? Mem.GrenadeCount(pawn, _ammoSlot[t]) : 1);
        }
        if (Mem.ArmorValue(pawn) > 0) total += Mem.HasHelmetItem(pawn) ? KevlarHelmetPrice : KevlarPrice;
        if (Mem.HasDefuserItem(pawn)) total += DefuserPrice;
        return total;
    }

    /// <summary>pi of the bot whose pawn the controller in <paramref name="slot"/> drives, or Nil when it drives its own.</summary>
    private int BodyPi(int slot)
    {
        if ((uint)slot >= MaxSlots) return Nil.V;
        ref var s = ref _slots[slot];
        if (!s.Valid) return Nil.V;
        uint orig = Mem.OriginalControllerHandle(s.Ctrl);
        if (orig == Mem.InvalidHandle || orig == s.Handle || Mem.ByHandle(orig) == 0) return Nil.V;
        int bodySlot = (int)(orig & 0x7FFF) - 1;
        return (uint)bodySlot < MaxSlots ? _slots[bodySlot].Pi : Nil.V;
    }

    private void ReadFrame(int slot, ref PlayerFrame f, bool place)
    {
        ref var s = ref _slots[slot];
        nint ctrl = Mem.ByIndex(slot + 1, out uint h);
        if (ctrl == 0 || ctrl != s.Ctrl || h != s.Handle) { f.Present = false; _nextRefresh = 0; return; }
        nint pawn = Mem.PawnOf(ctrl);
        if (pawn == 0) { f.Present = false; return; }
        Mem.Frame(pawn, s.Team, ref f, place ? _rec!.Places : null);
    }

    /// <summary>Fresh frames for the human and enemies, for the shot path.</summary>
    private void ReadAimFrames()
    {
        int human = _rec!.HumanPi;
        int humanTeam = _humanSlot >= 0 ? _slots[_humanSlot].Team : 0;
        for (int i = 0; i < _frames.ActiveCount; i++)
        {
            int pi = _frames.Active[i];
            int slot = _piSlot[pi];
            if (slot < 0) continue;
            if (pi == human || IsOpposing(_slots[slot].Team, humanTeam)) ReadFrame(slot, ref _frames.ByPi[pi], false);
        }
    }

    private void DrainMessages()
    {
        var w = _writer;
        if (w == null) return;
        while (w.Messages.TryDequeue(out var m))
        {
            Log(m.Level switch { MessageLevel.Error => LogLevel.Error, MessageLevel.Warn => LogLevel.Warning, _ => LogLevel.Information }, "writer: " + m.Text);
            if ((m.Resume != null || m.ScanDone) && !_mapGate.IsCurrentScan(m.Gen))
            {
                if (m.Resume != null) Log(LogLevel.Information, $"ignoring stale scan answer (generation {m.Gen}, current {_mapGate.ScanGen})");
                continue;
            }
            if (m.Resume != null) ResumeCapture(m.Resume, m.ResumeRounds, m.Gen);
            if (m.ScanDone && _mapGate.IsCurrentScan(m.Gen))
            {
                _mapGate.ScanDone();
                if (!_rec!.Capturing) StartMidMatchIfLive();
            }
        }
    }

    // ---- init and slots -------------------------------------------------------------------------

    private void TryInit()
    {
        CCSGameRulesProxy? proxy = null;
        foreach (var p in Utilities.FindAllEntitiesByDesignerName<CCSGameRulesProxy>("cs_gamerules")) { proxy = p; break; }
        if (proxy?.GameRules == null) return;
        if (!_memReady)
        {
            string? err = Mem.Init();
            if (err != null)
            {
                _disabled = true;
                Log(LogLevel.Error, $"DISABLED: raw entity access is not usable ({err}). Nothing will be recorded.");
                return;
            }
            _perRoundStride = Schema.GetSchemaOffset("CSMatchStats_t", "m_iEnemy5Ks");
            if (_perRoundStride <= 0) Log(LogLevel.Error, "CSPerRoundStats_t size unknown; reconciliation disabled.");
            _memReady = true;
        }
        _rules = proxy.GameRules;
        _teamT = _teamCt = null;
        foreach (var t in Utilities.FindAllEntitiesByDesignerName<CCSTeam>("cs_team_manager"))
        {
            if (t.TeamNum == 2) _teamT = t;
            else if (t.TeamNum == 3) _teamCt = t;
        }
        _map = Server.MapName;
        _mapGate.Initialized();
        _tick = Server.TickCount;
        RefreshSlots(true);
        _winPanelSeen = false;
        OnMapReady();
        Rescan("map start");
    }

    /// <summary>Requests a new scan for the live game identity; any answer to an earlier request becomes stale.</summary>
    private void Rescan(string why)
    {
        var rules = _rules!;
        int gen = _mapGate.NewScan();
        _scanGameStart = rules.GameStartTime;
        _scanRounds = rules.TotalRoundsPlayed;
        Log(LogLevel.Information, $"scan {gen} requested ({why})");
        _writer!.RequestScan(_map, _scanGameStart, gen);
    }

    private void ResetSlotPis()
    {
        for (int i = 0; i < MaxSlots; i++) _slots[i].Pi = Nil.V;
        Array.Fill(_piSlot, -1);
        _frames.ActiveCount = 0;
        _shotWeaponHandle = Mem.InvalidHandle;
    }

    /// <summary>
    /// Re-reads the 64 controller slots. Wrappers are created only for slots whose entity changed,
    /// so a steady server allocates nothing here.
    /// </summary>
    private void RefreshSlots(bool forceTeams)
    {
        var rec = _rec!;
        int humanSlot = -1;
        int active = 0;
        for (int slot = 0; slot < MaxSlots; slot++)
        {
            ref var s = ref _slots[slot];
            nint ctrl = Mem.ByIndex(slot + 1, out uint h);
            if (ctrl != s.Ctrl || h != s.Handle)
            {
                if (s.Pi != Nil.V && (uint)s.Pi < Limits.MaxPlayers) _piSlot[s.Pi] = -1;
                s = default;
                s.Pi = Nil.V;
                s.Ctrl = ctrl;
                s.Handle = h;
                s.Pending = ctrl != 0;
            }
            if (s.Pending) Identify(ref s);
            if (!s.Valid) continue;
            int team = Mem.Read<byte>(s.Ctrl, Mem.Team);
            if (rec.Capturing && s.Pi == Nil.V)
            {
                s.Pi = rec.PlayerIndex(s.Key!, s.Name!, s.IsBot);
                if (s.Pi != Nil.V) { _piSlot[s.Pi] = slot; forceTeams = true; }
            }
            if (team != s.Team || forceTeams)
            {
                s.Team = team;
                if (s.Pi != Nil.V) rec.SetTeam(s.Pi, team);
            }
            if (!s.IsBot && s.SteamId != 0 && humanSlot < 0) humanSlot = slot;
            if (s.Pi != Nil.V) _frames.Active[active++] = s.Pi;
        }
        _frames.ActiveCount = active;
        _humanSlot = humanSlot;
        _frames.HumanSlot = humanSlot;
        if (rec.Capturing && humanSlot >= 0)
        {
            int hp = _slots[humanSlot].Pi;
            if (rec.HumanPi == Nil.V && hp != Nil.V) rec.SetHuman(hp);
        }
    }

    private static void Identify(ref Slot s)
    {
        var c = new CCSPlayerController(s.Ctrl);
        if (!c.IsValid || c.DesignerName != "cs_player_controller" || c.IsHLTV) { s.Pending = false; return; }
        if (c.Connected != PlayerConnectedState.Connected) return; // stays pending until fully connected
        s.Pending = false;
        s.Valid = true;
        s.IsBot = c.IsBot;
        s.Name = c.PlayerName;
        s.SteamId = s.IsBot ? 0 : c.SteamID;
        s.Key = s.IsBot ? "B:" + s.Name : s.SteamId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        s.Team = -1;
    }

    private int PiOf(CCSPlayerController? c)
    {
        if (c == null || !c.IsValid) return Nil.V;
        int slot = c.Slot;
        if ((uint)slot >= MaxSlots) return Nil.V;
        if (_slots[slot].Pi == Nil.V && _rec!.Capturing) RefreshSlots(false);
        return _slots[slot].Pi;
    }

    private int SlotOfEventPlayer(GameEvent e, string field)
    {
        nint ptr = NativeAPI.GetEventPlayerController(e.Handle, field);
        if (ptr == 0) return -1;
        for (int i = 0; i < MaxSlots; i++) if (_slots[i].Ctrl == ptr) return i;
        return -1;
    }

    private nint PawnOfSlot(int slot)
    {
        if ((uint)slot >= MaxSlots) return 0;
        ref var s = ref _slots[slot];
        nint ctrl = Mem.ByIndex(slot + 1, out uint h);
        if (ctrl == 0 || ctrl != s.Ctrl || h != s.Handle) return 0;
        return Mem.PawnOf(ctrl);
    }

    /// <summary>Once a second: current equipment value and grenades held, for kill states and utility at death.</summary>
    private void RefreshEconomy()
    {
        for (int slot = 0; slot < MaxSlots; slot++)
        {
            ref var s = ref _slots[slot];
            if (!s.Valid || s.Pi == Nil.V) continue;
            nint pawn = PawnOfSlot(slot);
            if (pawn == 0 || !Mem.Alive(pawn)) continue;
            _rec!.SetEquipNow(s.Pi, EquipOf(pawn));
            var u = Mem.Utility(pawn, _ammoSlot, out int n);
            if (n > 0) s.Util = u;
        }
    }

    // ---- lifecycle ------------------------------------------------------------------------------

    private EnvInfo CurrentEnv() => new()
    {
        Plugin = ModuleVersion,
        Cssharp = Api.GetVersionString(),
        TickRate = (int)Math.Round(1.0 / Server.TickInterval),
        MaxRounds = ConVarInt("mp_maxrounds"),
        BotDifficulty = ConVarInt("bot_difficulty"),
        Halftime = ConVarInt("mp_halftime") != 0,
    };

    private int ConVarInt(string name)
    {
        try
        {
            var cv = ConVar.Find(name);
            if (cv == null) return Nil.V;
            return cv.Type == ConVarType.Bool ? (cv.GetPrimitiveValue<bool>() ? 1 : 0) : cv.GetPrimitiveValue<int>();
        }
        catch (Exception ex)
        {
            Log(LogLevel.Warning, $"could not read {name}: {ex.Message}");
            return Nil.V;
        }
    }

    private void StartCapture(int firstFullRound)
    {
        var rules = _rules!;
        double sinceStart = Math.Max(0, Server.CurrentTime - rules.GameStartTime);
        var meta = new MatchMeta
        {
            Id = RandomNumberGenerator.GetHexString(32, lowercase: true),
            Map = _map,
            StartUtc = MatchCodec.IsoUtc(DateTime.UtcNow.AddSeconds(-sinceStart)),
            Env = CurrentEnv(),
            FirstFullRound = firstFullRound,
            GameStart = rules.GameStartTime,
            Status = "inprogress",
        };
        _rec!.StartCapture(meta);
        ResetSlotPis();
        RefreshSlots(true);
        Log(LogLevel.Information, $"capture {meta.Id} started on {_map}, firstFullRound={firstFullRound}");
    }

    private void ResumeCapture(MatchMeta meta, int roundsInFile, int gen)
    {
        var rules = _rules!;
        meta.RoundCount = roundsInFile;
        if (!Lifecycle.AcceptResume(gen, _mapGate.ScanGen, meta, _map, rules.GameStartTime, rules.TotalRoundsPlayed, rules.WarmupPeriod))
        {
            // The file is from another game than the one running now (e.g. a restart during the scan).
            // Rescanning with the live identity writes that file out as abandoned.
            Log(LogLevel.Information, $"in-progress match {meta.Id} does not match the live game; not resuming it");
            Rescan("resume rejected");
            return;
        }
        var env = CurrentEnv();
        meta.Env.Halftime = env.Halftime;
        meta.Status = "inprogress";
        _rec!.Resume(meta);
        ResetSlotPis();
        RefreshSlots(true);
        bool postRound = rules.RoundWinStatus != 0;
        int r = rules.TotalRoundsPlayed;
        AddPriorRounds(roundsInFile, r);
        if (!postRound && roundsInFile <= r) BeginRoundMidway(r);
        Log(LogLevel.Information, $"resumed {meta.Id}; last known round {_rec.LastRound}");
        if (Lifecycle.MatchOverAtResume(_winPanelSeen, rules.GamePhase))
        {
            // The match ended while capture was unavailable; nothing later would close it.
            Log(LogLevel.Information, "match already over at resume; writing the final file");
            _matchEndAt = _tick + _rec.TickRate;
        }
    }

    /// <summary>Loaded while a match is live and nothing to resume: rounds so far come from the game's round results.</summary>
    private void StartMidMatchIfLive()
    {
        var rules = _rules;
        if (rules == null || rules.WarmupPeriod || !rules.HasMatchStarted || _humanSlot < 0) return;
        if (Lifecycle.MatchOverAtResume(_winPanelSeen, rules.GamePhase)) return; // nothing left to record
        int r = rules.TotalRoundsPlayed;
        bool postRound = rules.RoundWinStatus != 0;
        StartCapture(postRound ? r : r + 1);
        AddPriorRounds(0, r);
        if (!postRound) BeginRoundMidway(r);
    }

    private void AddPriorRounds(int from, int to)
    {
        var results = _rules!.MatchStats_RoundResults;
        for (int ri = from; ri < to; ri++) _rec!.AddPriorRound(ri, ri < results.Length ? results[ri] : 0);
    }

    private void BeginRoundMidway(int r)
    {
        var rules = _rules!;
        int freeze = Nil.V;
        if (!rules.FreezePeriod)
            freeze = _tick - (int)Math.Round((Server.CurrentTime - rules.RoundStartTime) * _rec!.TickRate);
        _rec!.BeginRound(r, _tick, _teamT?.Score ?? Nil.V, _teamCt?.Score ?? Nil.V, partial: true, freeze);
    }

    private void FinalizeRound()
    {
        var rec = _rec!;
        if (!rec.RoundActive || rec.RoundFinalized) return;
        var results = _rules!.MatchStats_RoundResults;
        int code = rec.Ri >= 0 && rec.Ri < results.Length ? results[rec.Ri] : 0;
        rec.Finalize(code, _tick);
    }

    private void Reconcile()
    {
        var rec = _rec!;
        if (!rec.RoundActive || _perRoundStride <= 0) return;
        int ri = rec.Ri;
        Array.Clear(_haveStats);
        for (int slot = 0; slot < MaxSlots; slot++)
        {
            ref var s = ref _slots[slot];
            if (!s.Valid || (uint)s.Pi >= Limits.MaxPlayers) continue;
            if (ReadPerRoundStats(slot, ri, out var st)) { _gameStats[s.Pi] = st; _haveStats[s.Pi] = true; }
        }
        rec.Reconcile(ri, _gameStats, _haveStats);
    }

    /// <summary>The game's own kills, deaths, assists and damage for one player in round <paramref name="ri"/>.</summary>
    private bool ReadPerRoundStats(int slot, int ri, out GameRoundStats stats)
    {
        stats = default;
        if (_perRoundStride <= 0) return false;
        var ats = new CCSPlayerController(_slots[slot].Ctrl).ActionTrackingServices;
        if (ats == null) return false;
        nint vec = ats.PerRoundStats.Handle;
        int count = Marshal.ReadInt32(vec);
        nint elems = Marshal.ReadIntPtr(vec + 8);
        if (ri < 0 || ri >= count || count > 512 || elems == 0) return false;
        var st = new CSPerRoundStats_t(elems + ri * _perRoundStride);
        stats = new GameRoundStats { Kills = st.Kills, Deaths = st.Deaths, Assists = st.Assists, Damage = st.Damage };
        return true;
    }

    private void EndMatch()
    {
        var rec = _rec!;
        if (!rec.Capturing) return;
        FinalizeRound();
        Reconcile();
        rec.EndCapture("complete", MatchCodec.IsoUtc(DateTime.UtcNow), _tick);
    }

    private void Abandon(string why)
    {
        var rec = _rec!;
        if (!rec.Capturing) return;
        _finalizeAt = Nil.V;
        Log(LogLevel.Information, $"capture abandoned ({why})");
        rec.EndCapture("abandoned", MatchCodec.IsoUtc(DateTime.UtcNow), _tick);
    }

    // Asks the native entity list directly; unlike Utilities' cached accessor, a failure here is not remembered.
    private static bool EntityListReady()
    {
        try { return NativeAPI.GetConcreteEntityListPointer() != IntPtr.Zero; }
        catch (NativeException) { return false; }
    }

    // At both boundaries the gate closes and the scan is invalidated before the old capture is written
    // out; the old map's handles are dropped afterwards even if writing out throws.
    private void OnMapStart(string map)
    {
        _winPanelSeen = false;
        // Normally OnMapEnd already closed the capture; this covers a map change without it.
        try { _mapGate.MapStarted(() => Abandon("map change")); }
        finally { ForgetMap(); }
    }

    private void OnMapEnd()
    {
        try
        {
            _mapGate.MapEnded(() =>
            {
                FlushLogs();
                if (_rec == null) return;
                if (_matchEndAt != Nil.V) { _matchEndAt = Nil.V; EndMatch(); }
                else Abandon("map end");
            });
        }
        finally { ForgetMap(); }
    }

    private void ForgetMap()
    {
        _rules = null;
        _teamT = _teamCt = null;
        _finalizeAt = _matchEndAt = Nil.V;
    }
}
