namespace BotMatchStats.Core;

public interface IRecorderSink
{
    /// <summary>Returns an empty buffer from the pool.</summary>
    RoundBuffer Rent();
    /// <summary>Hands a sealed buffer to the worker. Must not block or touch the disk.</summary>
    void Submit(WriteJob job);
}

public struct KillInput
{
    public int Tick, Killer, Victim, Assister, Weapon, Flags;
    /// <summary>The kill was by a gun (used to attribute player_death.penetrated to the human's shot).</summary>
    public bool Bullet;
    /// <summary>GrenadeType of the killing grenade (from <see cref="WeaponNames.NadeSourceOf"/>), else Nil.</summary>
    public int NadeType;
    public bool AssistedFlash, HasKillerPos;
    public float KX, KY, KZ, VX, VY, VZ;
    public UtilCounts VictimUtil;
    /// <summary>pi of the bot whose pawn the killer / victim controlled, else Nil.</summary>
    public int KillerBody, VictimBody;
}

public struct ShotInput
{
    public int Tick, Weapon, Speed, MaxSpeed;
    /// <summary>WeaponClass, or Nil.</summary>
    public int Class;
    public bool Scoped, Ducked;
}

/// <summary>
/// Game-thread recorder for one match. It turns already-extracted facts (player indices, numbers,
/// positions) into rows, keeps the live state needed for kill states, damage caps and aim
/// engagements, and hands sealed buffers to the worker. It has no engine dependency, so the
/// tests replay recorded events through it.
/// </summary>
public sealed class Recorder
{
    public const int KillFlagHeadshot = 1, KillFlagWallbang = 2, KillFlagSmoke = 4, KillFlagBlind = 8, KillFlagNoscope = 16, KillFlagInAir = 32;
    /// <summary>The victim killed itself (bomb, fall, own grenade); killer is null. World deaths have killer null without this flag.</summary>
    public const int KillFlagSuicide = 64;
    /// <summary>The death happened before freeze end.</summary>
    public const int KillFlagFreeze = 128;
    public const int EquipFromPawn = 0, EquipFromInventory = 1;

    private readonly IRecorderSink _sink;
    private readonly Action<string> _warn;
    public readonly FrameSet Frames;
    public readonly PerfCounter Perf;
    public readonly NameTable Weapons = new(256);
    public readonly PlaceTable Places = new(128);
    /// <summary>Line of sight for the human; enabled when the game layer attaches a probe.</summary>
    public readonly LosTracker Los = new();
    private bool _losOffReported;

    private readonly List<PlayerInfo> _players = new();
    private readonly Dictionary<string, int> _playerByKey = new(StringComparer.Ordinal);
    private readonly List<int> _partial = new();
    private readonly List<int> _unknownResults = new();

    private readonly int[] _team = new int[Limits.MaxPlayers];
    private readonly bool[] _alive = new bool[Limits.MaxPlayers];
    private readonly int[] _hp = new int[Limits.MaxPlayers];
    private readonly int[] _lastPreHp = new int[Limits.MaxPlayers];
    private readonly int[] _lastHurtTick = new int[Limits.MaxPlayers];
    private readonly int[] _equipNow = new int[Limits.MaxPlayers];
    private readonly Tally[] _tally = new Tally[Limits.MaxPlayers];

    private readonly RoundRow _round = new();
    private readonly EngagementTracker _eng;
    private BurstTracker _burst = new(1);
    private RoundBuffer _buf;

    private struct ActiveSmoke { public int EntityId, EndTick; public double X, Y, Z; }
    private readonly FixedBuffer<ActiveSmoke> _smokes = new(32);

    private int _pendingShot = -1, _pendingShotTick;
    private bool _pendingImpactSet;
    private double _shotEyeX, _shotEyeY, _shotEyeZ, _shotPitch, _shotYaw;
    private int _eventWinner = Nil.V, _eventReason = Nil.V;

    // Utility links. Row indices are match-wide: rows handed off earlier plus the index in the current buffer.
    private const int DetTypes = 5;
    private int _grenadeBase, _throwBase;
    private readonly int[] _lastDet = new int[Limits.MaxPlayers * DetTypes];
    private readonly int[] _lastDetTick = new int[Limits.MaxPlayers * DetTypes];
    private struct PendingThrow { public int Thrower, Index; public GrenadeType Det; }
    private readonly FixedBuffer<PendingThrow> _pendingThrows = new(128);

    /// <summary>Damage and blinds link to the attacker's latest detonation of the matching type no older than this.</summary>
    public static int LinkWindowTicks(GrenadeType t, int tickRate) => t == GrenadeType.Molotov ? tickRate * 8 : tickRate;

    public MatchMeta Meta { get; private set; } = new();
    public bool Capturing { get; private set; }
    /// <summary>True from BeginRound until the next BeginRound or the end of the capture; events are recorded only then.</summary>
    public bool RoundActive { get; private set; }
    public bool RoundFinalized { get; private set; }
    /// <summary>Between freeze end and round end.</summary>
    public bool Live { get; private set; }
    public bool Planted { get; private set; }
    public int Ri { get; private set; } = Nil.V;
    public int FreezeTick => _round.FreezeTick;
    public int HumanPi => Meta.Human;
    public int TickRate => Meta.Env.TickRate;
    public int PlayerCount => _players.Count;
    /// <summary>Highest round index known to this capture (in the file or begun), or Nil. Survives a resume.</summary>
    public int LastRound { get; private set; } = Nil.V;
    private bool _freezeOver;
    private int _plantTick = Nil.V;
    private bool _roundPartial;

    public Recorder(IRecorderSink sink, FrameSet frames, PerfCounter perf, Action<string> warn)
    {
        _sink = sink;
        _warn = warn;
        Frames = frames;
        Perf = perf;
        _eng = new EngagementTracker(64);
        _buf = sink.Rent();
        ResetLive();
    }

    // ---- capture lifecycle ------------------------------------------------------------------

    public void StartCapture(MatchMeta meta)
    {
        Meta = meta;
        _players.Clear(); _playerByKey.Clear(); _partial.Clear(); _unknownResults.Clear();
        Weapons.Clear(); Places.Clear();
        Places.SetMap(meta.Map);
        _burst = new BurstTracker(1);
        _eng.Reset();
        Los.Reset();
        _losOffReported = false;
        _buf.Clear();
        _grenadeBase = meta.GrenadeCount;
        _throwBase = meta.ThrowCount;
        Array.Fill(_lastDet, Nil.V);
        Array.Fill(_lastDetTick, Nil.V);
        _pendingThrows.Clear();
        ResetLive();
        Capturing = true;
        // A failure before this capture (at map load, or the spawn self-check) belongs in its file too.
        if (Los.Failure != null) Meta.Env.LosError ??= Los.Failure;
        RoundActive = false;
        Ri = Nil.V;
        LastRound = Nil.V;
        Perf.Reset();
    }

    /// <summary>Continues a match from a decoded in-progress file (hot reload).</summary>
    public void Resume(MatchMeta meta)
    {
        StartCapture(meta);
        foreach (var p in meta.Players) { _playerByKey[p.Key] = _players.Count; _players.Add(p); }
        Weapons.Load(meta.Weapons);
        Places.Load(meta.Places);
        Places.SetMap(meta.Map);
        _partial.AddRange(meta.PartialRounds);
        _unknownResults.AddRange(meta.UnknownResults);
        _burst = new BurstTracker(meta.NextBurst);
        LastRound = meta.RoundCount > 0 ? meta.RoundCount - 1 : Nil.V;
    }

    /// <summary>
    /// A round_start with this round counter belongs to a new game: the counter went back to or
    /// below a round this capture already has, or the server is in warmup. Uses <see cref="LastRound"/>,
    /// so it also works right after a resume, before any round has begun.
    /// </summary>
    public bool IsRestart(int roundsPlayed, bool warmup) => warmup || (LastRound != Nil.V && roundsPlayed <= LastRound);

    /// <summary>
    /// Adds a round that happened before capture began, known only from the game's round results.
    /// Every field other than winSide and how is null.
    /// </summary>
    public void AddPriorRound(int ri, int resultCode)
    {
        if (!Capturing) return;
        var row = new RoundRow();
        row.Reset(ri);
        SetResult(row, ri, resultCode, Nil.V);
        _buf.AddRound(row);
        if (!_partial.Contains(ri)) _partial.Add(ri);
        if (LastRound == Nil.V || ri > LastRound) LastRound = ri;
    }

    public void BeginRound(int ri, int tick, int scoreT, int scoreCt, bool partial, int freezeTickIfLive)
    {
        if (!Capturing) return;
        Ri = ri;
        _round.Reset(ri);
        _round.ScoreT = scoreT;
        _round.ScoreCt = scoreCt;
        Array.Clear(_tally);
        Array.Fill(_hp, Nil.V);
        Array.Fill(_lastPreHp, Nil.V);
        Array.Fill(_lastHurtTick, Nil.V);
        Planted = false;
        _plantTick = Nil.V;
        _eventWinner = _eventReason = Nil.V;
        _eng.Reset();
        Los.Reset();
        Array.Fill(_lastDet, Nil.V);
        Array.Fill(_lastDetTick, Nil.V);
        _pendingThrows.Clear();
        _smokes.Clear();
        _roundPartial = partial;
        if (partial && !_partial.Contains(ri)) _partial.Add(ri);
        RoundActive = true;
        RoundFinalized = false;
        Live = false;
        _freezeOver = false;
        if (LastRound == Nil.V || ri > LastRound) LastRound = ri;
        if (freezeTickIfLive != Nil.V)
        {
            _round.FreezeTick = freezeTickIfLive;
            GoLive();
        }
    }

    public void SetFreezePlayer(int pi, int side, int money, int equip, int hp, bool alive)
    {
        if (!RoundActive || (uint)pi >= Limits.MaxPlayers) return;
        if (side == 2 || side == 3) _round.Side[pi] = side;
        _round.Money[pi] = money;
        _round.Equip[pi] = equip;
        _round.Alive0[pi] = alive ? 1 : 0;
        _team[pi] = side;
        _alive[pi] = alive;
        _hp[pi] = alive ? hp : 0;
        _equipNow[pi] = equip;
        if (Ri == 0 && (side == 2 || side == 3)) SetStartSide(pi, side);
    }

    public void FreezeEnd(int tick)
    {
        if (!RoundActive) return;
        _round.FreezeTick = tick;
        GoLive();
    }

    /// <summary>
    /// A round becomes live: at freeze end, or at once when capture starts mid-round. Either way the
    /// file records the visibility source in use and, if line of sight failed earlier, why.
    /// </summary>
    private void GoLive()
    {
        Live = true;
        _freezeOver = true;
        NoteVisSource(Los.Enabled ? "los" : "mask");
        if (Los.Failure != null) Meta.Env.LosError ??= Los.Failure;
    }

    /// <summary>
    /// Every line-of-sight failure ends here: tracing stops at once, visible enemies are closed at
    /// <paramref name="tick"/>, the file records why (env.losError, env.visSource), and visibility
    /// falls back to the spotted mask for the rest of the map.
    /// </summary>
    /// <summary>Attaches a probe for a new map; a failure on the previous map no longer applies.</summary>
    public void AttachLos(ILosProbe? probe)
    {
        Los.Attach(probe);
        _losOffReported = false;
    }

    public void DisableLos(string why, int tick)
    {
        Los.Fail(why);
        if (_losOffReported) return;
        _losOffReported = true;
        if (Capturing)
        {
            Meta.Env.LosError ??= Los.Failure;
            NoteVisSource("mask");
            if (RoundActive && Live) Los.HideAll(Ri, tick, _buf.Los);
        }
        _warn($"Line of sight turned off: {Los.Failure}. Visibility falls back to the spotted mask.");
    }

    /// <summary>env.visSource: "los" or "mask" for the whole match, "mixed" when it changed (line of sight failed or was unavailable for some rounds).</summary>
    private void NoteVisSource(string name)
    {
        var env = Meta.Env;
        if (env.VisSource == null) env.VisSource = name;
        else if (env.VisSource != name) env.VisSource = "mixed";
    }

    /// <summary>Records which source this round's equipment values came from (see EquipFromPawn/EquipFromInventory).</summary>
    public void SetEquipSource(int source)
    {
        if (!RoundActive) return;
        _round.EquipSrc = source;
        string name = source == EquipFromInventory ? "inventory" : "pawn";
        var env = Meta.Env;
        if (env.EquipSource == null) env.EquipSource = name;
        else if (env.EquipSource != name) env.EquipSource = "mixed";
    }

    /// <summary>The human damaged an enemy: keep the victim's raw spotted state for validating visibility.</summary>
    public void HitMask(int tick, int attacker, int victim, uint m0, uint m1, bool spotted)
    {
        if (!RoundActive || attacker != Meta.Human || attacker == Nil.V || (uint)victim >= Limits.MaxPlayers || !IsEnemy(attacker, victim)) return;
        _buf.HitMask.Add(new HitMaskRow { Ri = Ri, Tick = tick, Victim = victim, M0 = m0, M1 = m1, Spotted = spotted });
    }

    /// <summary>Records the human's slot, controller index and pawn index once per match.</summary>
    public void SetHumanEntities(int slot, int controllerIndex, int pawnIndex)
    {
        var env = Meta.Env;
        if (env.HumanSlot != Nil.V) return;
        env.HumanSlot = slot;
        env.HumanController = controllerIndex;
        env.HumanPawn = pawnIndex;
    }

    /// <summary>A player left the server during the round.</summary>
    public void Leave(int tick, int pi)
    {
        if (!RoundActive || (uint)pi >= Limits.MaxPlayers) return;
        _buf.Leaves.Add(new LeaveRow { Ri = Ri, Tick = tick, Pi = pi, Alive = _alive[pi] ? 1 : 0 });
        _alive[pi] = false;
    }

    // ---- players ----------------------------------------------------------------------------

    /// <summary>Returns the player index for a key, adding the player on first sight (allocates only then).</summary>
    public int PlayerIndex(string key, string name, bool isBot)
    {
        if (_playerByKey.TryGetValue(key, out int pi)) return pi;
        if (_players.Count >= Limits.MaxPlayers) return Nil.V;
        pi = _players.Count;
        _players.Add(new PlayerInfo { Key = key, Name = name, IsBot = isBot, StartSide = Nil.V });
        _playerByKey.Add(key, pi);
        return pi;
    }

    public void SetHuman(int pi) => Meta.Human = pi;

    public void SetTeam(int pi, int team)
    {
        if ((uint)pi >= Limits.MaxPlayers) return;
        _team[pi] = team;
        if (RoundActive && (team == 2 || team == 3))
        {
            if (_round.Side[pi] == Nil.V && !RoundFinalized) _round.Side[pi] = team;
            int ss = Sides.StartSide(team, Ri, Meta.Env.MaxRounds, Meta.Env.Halftime);
            if (ss != Nil.V && _players[pi].StartSide == Nil.V) SetStartSide(pi, ss);
        }
    }

    private void SetStartSide(int pi, int side)
    {
        var p = _players[pi];
        if (p.StartSide == side) return;
        p.StartSide = side;
        _players[pi] = p;
    }

    public void SetAlive(int pi, bool alive, int hp)
    {
        if ((uint)pi >= Limits.MaxPlayers) return;
        _alive[pi] = alive;
        if (alive && hp > 0) _hp[pi] = hp;
    }

    public bool IsAlive(int pi) => (uint)pi < Limits.MaxPlayers && _alive[pi];

    public void SetEquipNow(int pi, int value)
    {
        if ((uint)pi < Limits.MaxPlayers) _equipNow[pi] = value;
    }

    // ---- events -----------------------------------------------------------------------------

    public void Kill(in KillInput k)
    {
        if (!RoundActive || (uint)k.Victim >= Limits.MaxPlayers) return;
        int v = k.Victim;
        // A dead enemy, or every enemy once the human dies, leaves the human's sight at the kill tick.
        // The human saw the enemies (and the victim was in sight) up to the kill tick; see LosTracker.HideDead.
        if (v == Meta.Human) Los.HideAllHumanDied(Ri, k.Tick, _buf.Los);
        else Los.HideDead(Ri, k.Tick, v, _buf.Los);
        int killer = k.Killer == v ? Nil.V : k.Killer;
        int flags = k.Flags;
        if (k.Killer == v) flags |= KillFlagSuicide;
        if (!_freezeOver) flags |= KillFlagFreeze;
        int assister = Nil.V, flash = Nil.V;
        if (killer != Nil.V && k.Assister != Nil.V && k.Assister != v)
        {
            if (k.AssistedFlash) flash = k.Assister; else assister = k.Assister;
        }

        var row = new KillRow
        {
            Ri = Ri, Tick = k.Tick, Killer = killer, Victim = v, Assister = assister, FlashAssister = flash,
            Weapon = k.Weapon, Flags = flags, KBody = killer == Nil.V ? Nil.V : k.KillerBody, VBody = k.VictimBody,
            KX = Nil.V, KY = Nil.V, KZ = Nil.V,
            VX = AimMath.Round(k.VX), VY = AimMath.Round(k.VY), VZ = AimMath.Round(k.VZ),
            Planted = Planted ? 1 : 0,
            SincePlant = Planted && _plantTick != Nil.V ? k.Tick - _plantTick : Nil.V,
            Nade = LinkNade(killer, k.NadeType, k.Tick),
            VUtil = k.VictimUtil,
        };
        if (killer != Nil.V && k.HasKillerPos)
        {
            row.KX = AimMath.Round(k.KX); row.KY = AimMath.Round(k.KY); row.KZ = AimMath.Round(k.KZ);
        }
        FillState(ref row, k.Tick, v);
        _buf.Kills.Add(row);

        if (killer != Nil.V && killer == Meta.Human && k.Bullet && IsEnemy(killer, v))
            MergePen(k.Tick, (k.Flags & KillFlagWallbang) != 0 ? 1 : 0);

        _tally[v].Deaths++;
        if (killer != Nil.V && (uint)killer < Limits.MaxPlayers && IsEnemy(killer, v)) _tally[killer].Kills++;
        int anyAssist = assister != Nil.V ? assister : flash;
        if ((uint)anyAssist < Limits.MaxPlayers) _tally[anyAssist].Assists++;

        int human = Meta.Human;
        if (v == human) _eng.HumanDied(k.Tick, _buf.Engagements);
        else _eng.EnemyDied(k.Tick, v, killer == human && human != Nil.V, _buf.Engagements);

        _alive[v] = false;
        _hp[v] = 0;
    }

    private bool IsEnemy(int a, int b)
    {
        int ta = _team[a], tb = _team[b];
        return (ta == 2 || ta == 3) && (tb == 2 || tb == 3) && ta != tb;
    }

    /// <summary>The round state just before the kill. The victim counts as alive with its HP before the fatal hit.</summary>
    private void FillState(ref KillRow row, int tick, int victim)
    {
        int ctAlive = 0, tAlive = 0, ctHp = 0, tHp = 0, ctEq = 0, tEq = 0;
        bool ctHpKnown = true, tHpKnown = true, ctEqKnown = true, tEqKnown = true;
        int n = _players.Count;
        for (int pi = 0; pi < n; pi++)
        {
            if (!_alive[pi]) continue;
            int team = _team[pi];
            if (team != 2 && team != 3) continue;
            int hp = pi == victim && _lastHurtTick[pi] == tick ? _lastPreHp[pi] : _hp[pi];
            int eq = _equipNow[pi];
            if (team == 3)
            {
                ctAlive++;
                if (hp == Nil.V) ctHpKnown = false; else ctHp += hp;
                if (eq == Nil.V) ctEqKnown = false; else ctEq += eq;
            }
            else
            {
                tAlive++;
                if (hp == Nil.V) tHpKnown = false; else tHp += hp;
                if (eq == Nil.V) tEqKnown = false; else tEq += eq;
            }
        }
        row.CtAlive = ctAlive; row.TAlive = tAlive;
        row.CtHp = ctHpKnown ? ctHp : Nil.V; row.THp = tHpKnown ? tHp : Nil.V;
        row.CtEquip = ctEqKnown ? ctEq : Nil.V; row.TEquip = tEqKnown ? tEq : Nil.V;
    }

    /// <param name="nadeType">GrenadeType of the damaging grenade (HE or fire), else Nil.</param>
    public void Hurt(int tick, int attacker, int victim, int dmgHealth, int dmgArmor, int healthAfter, int weapon, int hitgroup, bool bullet, int nadeType)
    {
        if (!RoundActive || (uint)victim >= Limits.MaxPlayers) return;
        int dmg = DamageCap.Cap(dmgHealth, healthAfter, _hp[victim], out int preHp, out bool unknown);
        _hp[victim] = Math.Max(healthAfter, 0);
        _lastPreHp[victim] = preHp;
        _lastHurtTick[victim] = tick;
        if (attacker == Nil.V || attacker == victim || (uint)attacker >= Limits.MaxPlayers) return;
        if (unknown) _buf.CapUnknown++;

        _buf.Damage.Add(new DamageRow
        {
            Ri = Ri, Tick = tick, Attacker = attacker, Victim = victim, Dmg = dmg, DmgArmor = dmgArmor,
            Weapon = weapon, Hitgroup = hitgroup, Nade = LinkNade(attacker, nadeType, tick),
        });
        if (IsEnemy(attacker, victim))
        {
            _tally[attacker].Damage += dmg;
            _tally[attacker].Hits++;
        }
        if (attacker == Meta.Human)
        {
            _eng.Damage(tick, victim);
            if (bullet && _pendingShot >= 0 && _pendingShotTick == tick)
            {
                ref var s = ref _buf.Shots[_pendingShot];
                if (s.Hit == Nil.V) s.Hit = hitgroup;
            }
            // A lethal hit is resolved by player_death.penetrated. Without a ray trace, a non-fatal
            // hit's path is unknown, so pen becomes null.
            if (bullet && healthAfter > 0 && IsEnemy(attacker, victim)) MergePen(tick, Nil.V);
        }
    }

    public void Blind(int tick, int attacker, int victim, int ms)
    {
        if (!RoundActive || ms <= 0) return;
        _buf.Blinds.Add(new BlindRow
        {
            Ri = Ri, Tick = tick, Attacker = attacker, Victim = victim, Ms = ms,
            Flash = LinkNade(attacker, (int)GrenadeType.Flash, tick),
        });
    }

    public void Throw(int tick, int thrower, UtilType type, float x, float y, float z)
    {
        if (!RoundActive) return;
        int i = _buf.Throws.Add(new ThrowRow
        {
            Ri = Ri, Tick = tick, Thrower = thrower, Type = type,
            X = AimMath.Round(x), Y = AimMath.Round(y), Z = AimMath.Round(z),
        });
        if (i >= 0 && thrower != Nil.V)
            _pendingThrows.Add(new PendingThrow { Thrower = thrower, Index = _throwBase + i, Det = WeaponNames.DetonationOf(type) });
    }

    /// <summary>A detonation, linked to the thrower's oldest unlinked throw of the same kind this round.</summary>
    /// <param name="entityId">Projectile entity index, used to match smokegrenade_expired; Nil if unknown.</param>
    public void Grenade(int tick, int thrower, GrenadeType type, float x, float y, float z, int entityId = Nil.V)
    {
        if (!RoundActive) return;
        int link = Nil.V;
        if (thrower != Nil.V)
        {
            for (int j = 0; j < _pendingThrows.Count; j++)
            {
                ref var p = ref _pendingThrows[j];
                if (p.Index == Nil.V || p.Thrower != thrower || p.Det != type) continue;
                link = p.Index;
                p.Index = Nil.V;
                break;
            }
        }
        int i = _buf.Grenades.Add(new GrenadeRow
        {
            Ri = Ri, Tick = tick, Thrower = thrower, Type = type, Throw = link,
            X = AimMath.Round(x), Y = AimMath.Round(y), Z = AimMath.Round(z),
        });
        if (type == GrenadeType.Smoke)
            _smokes.Add(new ActiveSmoke { EntityId = entityId, EndTick = tick + (int)(SmokeRay.LifetimeSeconds * TickRate), X = x, Y = y, Z = z });
        if (i >= 0 && (uint)thrower < Limits.MaxPlayers)
        {
            _lastDet[thrower * DetTypes + (int)type] = _grenadeBase + i;
            _lastDetTick[thrower * DetTypes + (int)type] = tick;
        }
    }

    /// <summary>smokegrenade_expired: the smoke stops blocking from this tick.</summary>
    public void SmokeExpired(int tick, int entityId)
    {
        if (entityId == Nil.V) return;
        for (int i = 0; i < _smokes.Count; i++)
        {
            ref var s = ref _smokes[i];
            if (s.EntityId == entityId && s.EndTick > tick) s.EndTick = tick;
        }
    }

    private bool RayCrossesSmoke(int tick, double ox, double oy, double oz, double dx, double dy, double dz, double len)
    {
        for (int i = 0; i < _smokes.Count; i++)
        {
            ref var s = ref _smokes[i];
            if (tick >= s.EndTick) continue;
            if (SmokeRay.SegmentHitsSphere(ox, oy, oz, dx, dy, dz, len, s.X, s.Y, s.Z, SmokeRay.Radius)) return true;
        }
        return false;
    }

    /// <summary>Penetration evidence for the human's shot in this tick: 1 beats unknown, unknown beats 0.</summary>
    private void MergePen(int tick, int value)
    {
        if (_pendingShot < 0 || _pendingShotTick != tick) return;
        ref var s = ref _buf.Shots[_pendingShot];
        if (s.Pen == 1) return;
        if (value == 1 || value == Nil.V) s.Pen = value;
    }

    /// <summary>
    /// Whether an enemy is visible to the human: line of sight (<see cref="LosTracker"/>, held between
    /// its 16 Hz checks) when the game layer provides traces, else the engine's spotted mask at the
    /// human's slot. The slot bit is right, but the mask is the radar's spotted state and was set for
    /// only 53 of 93 bullet hits in the 2026-10-25 recordings. Engagements and visTarget both use this.
    /// </summary>
    private bool IsVisibleToHuman(int pi, in PlayerFrame enemy) =>
        Los.Enabled ? Los.IsVisible(pi) : Spotted.IsSpottedBy(enemy.Spot0, enemy.Spot1, Frames.HumanSlot);

    private int LinkNade(int attacker, int nadeType, int tick)
    {
        if ((uint)attacker >= Limits.MaxPlayers || (uint)nadeType >= DetTypes) return Nil.V;
        int slot = attacker * DetTypes + nadeType;
        int t = _lastDetTick[slot];
        if (t == Nil.V || tick < t || tick - t > LinkWindowTicks((GrenadeType)nadeType, TickRate)) return Nil.V;
        return _lastDet[slot];
    }

    /// <summary>A grenade purchase. A Nil <paramref name="price"/> marks the player's utility spend for the round unknown.</summary>
    public void UtilBought(int pi, UtilType type, int price)
    {
        if (!RoundActive || (uint)pi >= Limits.MaxPlayers) return;
        _round.UtilBought[pi * UtilCounts.Types + (int)type]++;
        if (price == Nil.V) _round.UtilSpent[pi] = Nil.V;
        else if (_round.UtilSpent[pi] != Nil.V) _round.UtilSpent[pi] += price;
    }

    /// <summary><paramref name="site"/>: 0 = A, 1 = B, Nil = unknown.</summary>
    public void BombPlanted(int tick, int planter, int site)
    {
        if (!RoundActive) return;
        Planted = true;
        _plantTick = tick;
        _round.PlantTick = tick;
        _round.Planter = planter;
        _round.BombSite = site;
    }

    public void BombDefused(int tick, int defuser)
    {
        if (!RoundActive) return;
        _round.Defuser = defuser;
    }

    /// <summary>A bullet fired by the human. Frames for the human and enemies must be current.</summary>
    public void Shot(in ShotInput s)
    {
        if (!RoundActive) return;
        int human = Meta.Human;
        if ((uint)human >= Limits.MaxPlayers) return;
        _burst.Shot(s.Tick, TickRate);
        var row = new ShotRow
        {
            Ri = Ri, Tick = s.Tick, Weapon = s.Weapon, Burst = _burst.Burst, Idx = _burst.Index,
            Speed = s.Speed, MaxSpeed = s.MaxSpeed, Scoped = s.Scoped, Ducked = s.Ducked,
            Target = Nil.V, AimErrYaw = Nil.V, AimErrPitch = Nil.V, ImpYaw = Nil.V, ImpPitch = Nil.V, Hit = Nil.V,
            Smoke = 0, Impacts = 0, Pen = 0, VisTarget = Nil.V, Class = s.Class, Pitch = float.NaN, Yaw = float.NaN,
        };
        double targetDist = SmokeRay.MaxRange;
        ref var h = ref Frames.ByPi[human];
        bool haveView = h.Present;
        if (haveView)
        {
            double ex = h.X, ey = h.Y, ez = h.Z + h.ViewZ;
            double best = EngagementTracker.ShotConeDeg;
            for (int i = 0; i < Frames.ActiveCount; i++)
            {
                int pi = Frames.Active[i];
                if (pi == human) continue;
                ref var e = ref Frames.ByPi[pi];
                if (!e.Present || !e.Alive || !IsOpposing(h.Team, e.Team)) continue;
                double dx = e.X - ex, dy = e.Y - ey, dz = e.Z + e.ViewZ - ez;
                double ang = AimMath.AngleToDeg(h.Pitch, h.Yaw, dx, dy, dz);
                if (double.IsNaN(ang)) continue;
                _eng.Shot(s.Tick, pi, ang);
                // target no longer requires visibility: the spotted mask is unreliable (see
                // IsVisibleToHuman), so visibility is reported separately in visTarget.
                if (ang <= best)
                {
                    best = ang;
                    AimMath.Delta(h.Pitch, h.Yaw, dx, dy, dz, out double yd, out double pd);
                    row.Target = pi;
                    row.AimErrYaw = AimMath.Centi(yd);
                    row.AimErrPitch = AimMath.Centi(pd);
                    row.VisTarget = IsVisibleToHuman(pi, e) ? 1 : 0;
                    targetDist = Math.Sqrt(dx * dx + dy * dy + dz * dz);
                }
            }
            if (_smokes.Count > 0)
            {
                AimMath.Forward(h.Pitch, h.Yaw, out double fx, out double fy, out double fz);
                row.Smoke = RayCrossesSmoke(s.Tick, ex, ey, ez, fx, fy, fz, targetDist) ? 1 : 0;
            }
            _shotEyeX = ex; _shotEyeY = ey; _shotEyeZ = ez; _shotPitch = h.Pitch; _shotYaw = h.Yaw;
            row.Pitch = h.Pitch;
            row.Yaw = h.Yaw;
        }
        _pendingShot = _buf.Shots.Add(row);
        _pendingShotTick = s.Tick;
        _pendingImpactSet = !haveView;
    }

    /// <summary>The human's bullet_impact; only the first impact after each shot is kept.</summary>
    public void Impact(int tick, float x, float y, float z)
    {
        if (!RoundActive || _pendingShot < 0 || _pendingShotTick != tick) return;
        _buf.Shots[_pendingShot].Impacts++;
        if (_pendingImpactSet) return;
        _pendingImpactSet = true;
        AimMath.Delta(_shotPitch, _shotYaw, x - _shotEyeX, y - _shotEyeY, z - _shotEyeZ, out double yd, out double pd);
        ref var s = ref _buf.Shots[_pendingShot];
        s.ImpYaw = AimMath.Centi(yd);
        s.ImpPitch = AimMath.Centi(pd);
    }

    private static bool IsOpposing(int a, int b) => (a == 2 && b == 3) || (a == 3 && b == 2);

    // ---- per tick ---------------------------------------------------------------------------

    public bool HumanPosDue(int tick) => Live && _round.FreezeTick != Nil.V && Due(tick, TickRate / 4);
    public bool BotPosDue(int tick) => Live && _round.FreezeTick != Nil.V && Due(tick, TickRate);
    public bool CtSetupDue(int tick) => Live && Places.HasAreas && !_round.HasCtSetup && _round.FreezeTick != Nil.V
        && !_roundPartial && tick - _round.FreezeTick >= TickRate * 15;
    public bool NeedsAim => Live && (uint)Meta.Human < Limits.MaxPlayers && _alive[Meta.Human];
    public bool LosDue(int tick) => Live && Los.Enabled && _round.FreezeTick != Nil.V && Due(tick, LosTracker.CheckEveryTicks(TickRate));

    private void CheckLos(int tick, int human)
    {
        Los.Check(Ri, tick, human, Frames, _buf.Los);
        if (Los.Failure != null) DisableLos(Los.Failure, tick);
    }

    private bool Due(int tick, int every)
    {
        int rel = tick - _round.FreezeTick;
        return rel >= 0 && rel % every == 0;
    }

    /// <summary>Per-tick work. Allocation-free: reads frames, updates engagements, appends position rows.</summary>
    public void Tick(int tick)
    {
        if (!RoundActive || !Live) return;
        int human = Meta.Human;
        bool humanOk = (uint)human < Limits.MaxPlayers;
        bool humanAlive = humanOk && Frames.ByPi[human].Present && Frames.ByPi[human].Alive && _alive[human];

        if (humanAlive && LosDue(tick)) CheckLos(tick, human);
        else if (!humanAlive) Los.HumanSeenDead(Ri, tick, _buf.Los);
        if (humanAlive) AimTick(tick, human);

        if (humanAlive && HumanPosDue(tick)) AddPos(tick, human);
        if (BotPosDue(tick))
        {
            for (int i = 0; i < Frames.ActiveCount; i++)
            {
                int pi = Frames.Active[i];
                if (pi == human) continue;
                ref var f = ref Frames.ByPi[pi];
                if (f.Present && f.Alive && (f.Team == 2 || f.Team == 3)) AddPos(tick, pi);
            }
        }
        if (CtSetupDue(tick))
        {
            _round.HasCtSetup = true;
            Span<int> counts = stackalloc int[CtSetupCounter.Areas];
            for (int i = 0; i < Frames.ActiveCount; i++)
            {
                ref var f = ref Frames.ByPi[Frames.Active[i]];
                if (f.Present && f.Alive && f.Team == 3)
                    CtSetupCounter.Add(counts, f.Place == Nil.V ? CtSetupCounter.Other : Places.Area(f.Place));
            }
            counts.CopyTo(_round.CtSetup);
        }
    }

    private void AimTick(int tick, int human)
    {
        ref var h = ref Frames.ByPi[human];
        double ex = h.X, ey = h.Y, ez = h.Z + h.ViewZ;
        for (int i = 0; i < Frames.ActiveCount; i++)
        {
            int pi = Frames.Active[i];
            if (pi == human) continue;
            ref var e = ref Frames.ByPi[pi];
            if (!e.Present || !e.Alive || !IsOpposing(h.Team, e.Team))
            {
                if (_eng.IsActive(pi)) _eng.EnemyGone(tick, pi, _buf.Engagements);
                continue;
            }
            bool vis = IsVisibleToHuman(pi, e);
            if (!vis)
            {
                if (_eng.IsActive(pi)) _eng.Observe(Ri, tick, pi, false, double.NaN, 0, 0, 0, _buf.Engagements);
                continue;
            }
            double dx = e.X - ex, dy = e.Y - ey, dz = e.Z + e.ViewZ - ez;
            double ang = AimMath.AngleToDeg(h.Pitch, h.Yaw, dx, dy, dz);
            AimMath.Delta(h.Pitch, h.Yaw, dx, dy, dz, out double yd, out double pd);
            double dist = Math.Sqrt(dx * dx + dy * dy + dz * dz);
            _eng.Observe(Ri, tick, pi, true, ang, yd, pd, dist, _buf.Engagements);
        }
    }

    private void AddPos(int tick, int pi)
    {
        ref var f = ref Frames.ByPi[pi];
        _buf.Pos.Add(new PosRow
        {
            Ri = Ri, Tick = tick, Pi = pi,
            X = AimMath.Round(f.X), Y = AimMath.Round(f.Y), Z = AimMath.Round(f.Z),
            Place = f.Place, Alive = f.Alive ? 1 : 0,
        });
    }

    // ---- round end and hand-off -------------------------------------------------------------

    public void RoundEnd(int tick, int eventWinner, int eventReason)
    {
        if (!RoundActive || RoundFinalized) return;
        Live = false;
        _eventWinner = eventWinner;
        _eventReason = eventReason;
        if (_round.FreezeTick != Nil.V) _round.DurTicks = tick - _round.FreezeTick;
        _eng.CloseAll(tick, _buf.Engagements);
        Los.HideAll(Ri, tick, _buf.Los);
    }

    /// <summary>Economy at round end: equipment value kept (0 when dead) and whether the player survived holding a primary.</summary>
    public void SetRoundEndEconomy(int pi, int equipEnd, bool survivedWithPrimary)
    {
        if (!RoundActive || (uint)pi >= Limits.MaxPlayers) return;
        _round.EquipEnd[pi] = equipEnd;
        _round.SurvPrimary[pi] = survivedWithPrimary ? 1 : 0;
    }

    /// <summary>Seals the round with the game's result code and hands it to the worker as an in-progress write.</summary>
    public void Finalize(int resultCode, int tick)
    {
        if (!RoundActive || RoundFinalized) return;
        RoundFinalized = true;
        Live = false;
        _eng.CloseAll(tick, _buf.Engagements);
        Los.HideAll(Ri, tick, _buf.Los);
        SetResult(_round, Ri, resultCode, _eventWinner);
        if (_eventReason != Nil.V && RoundResult.FromEventReason(_eventReason, out int evHow) && _round.How != Nil.V && evHow != _round.How)
            _warn($"Round {Ri}: round_end reason {_eventReason} disagrees with MatchStats_RoundResults code {resultCode}; the file uses the result code.");
        _buf.AddRound(_round);
        _buf.Perf.Add(TakePerf());
        Submit(JobKind.InProgress);
    }

    private void SetResult(RoundRow row, int ri, int code, int eventWinner)
    {
        if (RoundResult.FromMatchStatsCode(code, out int win, out int how))
        {
            row.WinSide = win;
            row.How = how;
            if (eventWinner != Nil.V && eventWinner != win)
                _warn($"Round {ri}: round_end winner {eventWinner} disagrees with MatchStats_RoundResults code {code} (side {win}); the file uses the result code.");
        }
        else
        {
            row.WinSide = Nil.V;
            row.How = Nil.V;
            if (!_unknownResults.Contains(ri)) _unknownResults.Add(ri);
            _warn($"Round {ri}: UNKNOWN MatchStats_RoundResults code {code}; winSide and how are null. Add the code to RoundResult once its meaning is verified.");
        }
    }

    /// <summary>
    /// Compares this round's tallies with the game's per-round stats. <paramref name="have"/>[pi] is
    /// false when the game value could not be read (player gone). Call before the next BeginRound.
    /// </summary>
    public void Reconcile(int ri, ReadOnlySpan<GameRoundStats> game, ReadOnlySpan<bool> have)
    {
        if (!Capturing || ri != Ri) return;
        var rr = new ReconRound { Ri = ri };
        if (_roundPartial)
        {
            // Partial rounds are not compared (events are missing), but their coverage is still recorded.
            for (int pi = 0; pi < _players.Count; pi++) if (_round.Side[pi] != Nil.V) rr.Missing++;
            _buf.ReconRounds.Add(rr);
            return;
        }
        int n = Math.Min(_players.Count, game.Length);
        for (int pi = 0; pi < n; pi++)
        {
            bool played = _round.Side[pi] != Nil.V;
            if (!played) continue;
            if (!have[pi]) { rr.Missing++; continue; }
            rr.Checked++;
            ref var t = ref _tally[pi];
            int mask = Recon.Compare(t, game[pi]);
            if ((mask & 1) == 0) rr.KillsOk++; else Mismatch(ri, pi, ReconField.Kills, t.Kills, game[pi].Kills, t.Hits);
            if ((mask & 2) == 0) rr.DeathsOk++; else Mismatch(ri, pi, ReconField.Deaths, t.Deaths, game[pi].Deaths, t.Hits);
            if ((mask & 4) == 0) rr.AssistsOk++; else Mismatch(ri, pi, ReconField.Assists, t.Assists, game[pi].Assists, t.Hits);
            if ((mask & 8) == 0) rr.DamageOk++; else Mismatch(ri, pi, ReconField.Damage, t.Damage, game[pi].Damage, t.Hits);
        }
        _buf.ReconRounds.Add(rr);
    }

    private void Mismatch(int ri, int pi, ReconField f, int ours, int game, int hits)
    {
        _buf.Mismatches.Add(new ReconMismatch { Ri = ri, Pi = pi, Field = f, Ours = ours, Game = game, Hits = hits });
        string name = pi < _players.Count ? _players[pi].Name : pi.ToString(System.Globalization.CultureInfo.InvariantCulture);
        _warn(f == ReconField.Damage
            ? $"Recon round {ri} {name}: damage ours {ours} game {game} (allowed game-ours in 0..{hits})"
            : $"Recon round {ri} {name}: {Recon.FieldNames[(int)f]} ours {ours} game {game}");
    }

    public Tally TallyOf(int pi) => _tally[pi];

    /// <summary>Hands everything recorded since the last hand-off to the worker as an in-progress write.</summary>
    public void Flush()
    {
        if (Capturing) Submit(JobKind.InProgress);
    }

    /// <summary>Ends the capture and writes the final file. A round still open is sealed with a null result.</summary>
    public void EndCapture(string status, string endUtc, int tick)
    {
        if (!Capturing) return;
        if (RoundActive && !RoundFinalized)
        {
            if (!_partial.Contains(Ri)) _partial.Add(Ri);
            RoundFinalized = true;
            _eng.CloseAll(tick, _buf.Engagements);
            Los.HideAll(Ri, tick, _buf.Los);
            _buf.AddRound(_round);
            _buf.Perf.Add(TakePerf());
        }
        Meta.Status = status;
        Meta.EndUtc = endUtc;
        Submit(JobKind.Final);
        Capturing = false;
        RoundActive = false;
        Live = false;
        Ri = Nil.V;
        _players.Clear(); _playerByKey.Clear(); Weapons.Clear(); Places.Clear();
        _eng.Reset();
        ResetLive();
    }

    private void Submit(JobKind kind)
    {
        _grenadeBase += _buf.Grenades.Count;
        _throwBase += _buf.Throws.Count;
        var job = new WriteJob { Kind = kind, Buffer = _buf, Meta = Snapshot() };
        _buf = _sink.Rent();
        _pendingShot = -1;
        _sink.Submit(job);
    }

    /// <summary>The round's perf row, with the line-of-sight counters.</summary>
    private PerfRow TakePerf()
    {
        var row = Perf.Take(Ri);
        Los.TakeCounters(out row.LosChecks, out row.LosTraces, out row.LosBudgetHits, out long sum, out long max);
        row.LosAvgUs = row.LosChecks == 0 ? 0 : PerfCounter.Us(sum) / row.LosChecks;
        row.LosMaxUs = PerfCounter.Us(max);
        return row;
    }

    private MatchMeta Snapshot() => new()
    {
        Id = Meta.Id, Map = Meta.Map, StartUtc = Meta.StartUtc, EndUtc = Meta.EndUtc, Status = Meta.Status,
        Env = Meta.Env.Clone(), FirstFullRound = Meta.FirstFullRound, Human = Meta.Human,
        Weapons = Weapons.ToArray(), Places = Places.ToArray(), Players = _players.ToArray(),
        PartialRounds = _partial.ToArray(), UnknownResults = _unknownResults.ToArray(),
        GameStart = Meta.GameStart, NextBurst = _burst.NextBurstId,
        GrenadeCount = _grenadeBase, ThrowCount = _throwBase,
    };

    private void ResetLive()
    {
        Array.Fill(_team, 0);
        Array.Clear(_alive);
        Array.Fill(_hp, Nil.V);
        Array.Fill(_lastPreHp, Nil.V);
        Array.Fill(_lastHurtTick, Nil.V);
        Array.Fill(_equipNow, Nil.V);
        Array.Clear(_tally);
        _pendingShot = -1;
        Planted = false;
        _plantTick = Nil.V;
        _roundPartial = false;
    }
}
