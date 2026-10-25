using System.Globalization;
using System.Text.Json;

namespace BotMatchStats.Core;

/// <summary>
/// Encodes a <see cref="MatchStore"/> as schema v1 JSON (columnar tables) and decodes it back for
/// resuming. Runs on the worker thread only. Unknown values are written as null.
/// </summary>
public static class MatchCodec
{
    public const int Version = 1;

    private static readonly JsonWriterOptions WriterOptions = new() { Indented = false, SkipValidation = true };

    public static void Write(MatchStore s, Stream output, bool inProgress)
    {
        using var w = new Utf8JsonWriter(output, WriterOptions);
        var m = s.Meta;
        int np = m.Players.Length;
        w.WriteStartObject();
        w.WriteNumber("v", Version);
        w.WriteString("id", m.Id);
        w.WriteString("map", m.Map);
        w.WriteString("startUtc", m.StartUtc);
        StrOrNull(w, "endUtc", m.EndUtc);
        w.WriteString("status", m.Status);

        w.WriteStartObject("env");
        w.WriteString("plugin", m.Env.Plugin);
        StrOrNull(w, "cssharp", m.Env.Cssharp);
        StrOrNull(w, "game", m.Env.Game);
        IntProp(w, "tickrate", m.Env.TickRate);
        IntProp(w, "maxrounds", m.Env.MaxRounds);
        IntProp(w, "botDifficulty", m.Env.BotDifficulty);
        w.WriteEndObject();

        w.WriteNumber("firstFullRound", m.FirstFullRound);
        StrArray(w, "weapons", m.Weapons);
        StrArray(w, "places", m.Places);
        IntProp(w, "human", m.Human);

        w.WriteStartObject("players");
        w.WriteStartArray("key"); foreach (var p in m.Players) w.WriteStringValue(p.Key); w.WriteEndArray();
        w.WriteStartArray("name"); foreach (var p in m.Players) w.WriteStringValue(p.Name); w.WriteEndArray();
        w.WriteStartArray("isBot"); foreach (var p in m.Players) w.WriteBooleanValue(p.IsBot); w.WriteEndArray();
        w.WriteStartArray("startSide"); foreach (var p in m.Players) Int(w, p.StartSide); w.WriteEndArray();
        w.WriteEndObject();

        WriteRounds(w, s, np);

        var k = s.Kills.Span;
        w.WriteStartObject("kills");
        Col(w, "ri", k, static r => r.Ri); Col(w, "tick", k, static r => r.Tick);
        Col(w, "killer", k, static r => r.Killer); Col(w, "victim", k, static r => r.Victim);
        Col(w, "assister", k, static r => r.Assister); Col(w, "flashAssister", k, static r => r.FlashAssister);
        Col(w, "weapon", k, static r => r.Weapon); Col(w, "flags", k, static r => r.Flags);
        w.WriteStartArray("kpos"); foreach (ref readonly var r in k) Triple(w, r.KX, r.KY, r.KZ); w.WriteEndArray();
        w.WriteStartArray("vpos"); foreach (ref readonly var r in k) Triple(w, r.VX, r.VY, r.VZ); w.WriteEndArray();
        w.WriteStartArray("state");
        foreach (ref readonly var r in k)
        {
            w.WriteStartArray();
            Int(w, r.CtAlive); Int(w, r.TAlive); Int(w, r.CtHp); Int(w, r.THp);
            Int(w, r.CtEquip); Int(w, r.TEquip); Int(w, r.Planted); Int(w, r.SincePlant);
            w.WriteEndArray();
        }
        w.WriteEndArray();
        Col(w, "nade", k, static r => r.Nade);
        w.WriteStartArray("vUtil"); foreach (ref readonly var r in k) Util(w, r.VUtil); w.WriteEndArray();
        w.WriteEndObject();

        var d = s.Damage.Span;
        w.WriteStartObject("damage");
        Col(w, "ri", d, static r => r.Ri); Col(w, "tick", d, static r => r.Tick);
        Col(w, "attacker", d, static r => r.Attacker); Col(w, "victim", d, static r => r.Victim);
        Col(w, "dmg", d, static r => r.Dmg); Col(w, "dmgArmor", d, static r => r.DmgArmor);
        Col(w, "weapon", d, static r => r.Weapon); Col(w, "hitgroup", d, static r => r.Hitgroup);
        Col(w, "nade", d, static r => r.Nade);
        w.WriteEndObject();

        var b = s.Blinds.Span;
        w.WriteStartObject("blinds");
        Col(w, "ri", b, static r => r.Ri); Col(w, "tick", b, static r => r.Tick);
        Col(w, "attacker", b, static r => r.Attacker); Col(w, "victim", b, static r => r.Victim);
        Col(w, "ms", b, static r => r.Ms);
        Col(w, "flash", b, static r => r.Flash);
        w.WriteEndObject();

        var g = s.Grenades.Span;
        w.WriteStartObject("grenades");
        Col(w, "ri", g, static r => r.Ri); Col(w, "tick", g, static r => r.Tick);
        Col(w, "thrower", g, static r => r.Thrower);
        w.WriteStartArray("type"); foreach (ref readonly var r in g) w.WriteStringValue(WeaponNames.GrenadeTypeNames[(int)r.Type]); w.WriteEndArray();
        w.WriteStartArray("pos"); foreach (ref readonly var r in g) Triple(w, r.X, r.Y, r.Z); w.WriteEndArray();
        Col(w, "throw", g, static r => r.Throw);
        w.WriteEndObject();

        var th = s.Throws.Span;
        w.WriteStartObject("throws");
        Col(w, "ri", th, static r => r.Ri); Col(w, "tick", th, static r => r.Tick);
        Col(w, "thrower", th, static r => r.Thrower);
        w.WriteStartArray("type"); foreach (ref readonly var r in th) w.WriteStringValue(WeaponNames.UtilTypeNames[(int)r.Type]); w.WriteEndArray();
        w.WriteStartArray("pos"); foreach (ref readonly var r in th) Triple(w, r.X, r.Y, r.Z); w.WriteEndArray();
        w.WriteEndObject();

        var ps = s.Pos.Span;
        w.WriteStartObject("pos");
        Col(w, "ri", ps, static r => r.Ri); Col(w, "tick", ps, static r => r.Tick); Col(w, "pi", ps, static r => r.Pi);
        Col(w, "x", ps, static r => r.X); Col(w, "y", ps, static r => r.Y); Col(w, "z", ps, static r => r.Z);
        Col(w, "place", ps, static r => r.Place); Col(w, "alive", ps, static r => r.Alive);
        w.WriteEndObject();

        w.WriteStartObject("aim");
        var e = s.Engagements.Span;
        w.WriteStartObject("engagements");
        Col(w, "ri", e, static r => r.Ri); Col(w, "enemy", e, static r => r.Enemy); Col(w, "tVis", e, static r => r.TVis);
        Col(w, "angVis", e, static r => r.AngVis); Col(w, "angVisYaw", e, static r => r.AngVisYaw); Col(w, "angVisPitch", e, static r => r.AngVisPitch);
        Col(w, "dist", e, static r => r.Dist); Col(w, "tAimStart", e, static r => r.TAimStart);
        Col(w, "tFirstShot", e, static r => r.TFirstShot); Col(w, "tFirstDmg", e, static r => r.TFirstDmg);
        Col(w, "tEnd", e, static r => r.TEnd);
        w.WriteStartArray("outcome"); foreach (ref readonly var r in e) w.WriteStringValue(OutcomeName(r.Outcome)); w.WriteEndArray();
        w.WriteEndObject();

        var sh = s.Shots.Span;
        w.WriteStartObject("shots");
        Col(w, "ri", sh, static r => r.Ri); Col(w, "tick", sh, static r => r.Tick); Col(w, "weapon", sh, static r => r.Weapon);
        Col(w, "burst", sh, static r => r.Burst); Col(w, "idx", sh, static r => r.Idx);
        Col(w, "speed", sh, static r => r.Speed); Col(w, "maxSpeed", sh, static r => r.MaxSpeed);
        w.WriteStartArray("scoped"); foreach (ref readonly var r in sh) w.WriteBooleanValue(r.Scoped); w.WriteEndArray();
        w.WriteStartArray("ducked"); foreach (ref readonly var r in sh) w.WriteBooleanValue(r.Ducked); w.WriteEndArray();
        Col(w, "target", sh, static r => r.Target);
        w.WriteStartArray("aimErr"); foreach (ref readonly var r in sh) Pair(w, r.AimErrYaw, r.AimErrPitch); w.WriteEndArray();
        w.WriteStartArray("impact"); foreach (ref readonly var r in sh) Pair(w, r.ImpYaw, r.ImpPitch); w.WriteEndArray();
        Col(w, "hit", sh, static r => r.Hit);
        w.WriteEndObject();
        w.WriteEndObject(); // aim

        WriteRecon(w, s);
        WritePerf(w, s);

        if (inProgress)
        {
            w.WriteStartObject("resume");
            w.WriteNumber("gameStart", m.GameStart);
            w.WriteNumber("nextBurst", m.NextBurst);
            w.WriteEndObject();
        }
        w.WriteEndObject();
        w.Flush();
    }

    private static void WriteRounds(Utf8JsonWriter w, MatchStore s, int np)
    {
        int n = s.RoundCount;
        w.WriteStartObject("rounds");
        RoundCol(w, "winSide", s, static r => r.WinSide);
        w.WriteStartArray("how");
        for (int i = 0; i < n; i++) { int h = s.Round(i).How; if (h == Nil.V) w.WriteNullValue(); else w.WriteStringValue(RoundResult.HowNames[h]); }
        w.WriteEndArray();
        RoundCol(w, "freezeTick", s, static r => r.FreezeTick);
        RoundCol(w, "durTicks", s, static r => r.DurTicks);
        w.WriteStartArray("bombSite");
        for (int i = 0; i < n; i++) { int b = s.Round(i).BombSite; if (b == 0) w.WriteStringValue("A"); else if (b == 1) w.WriteStringValue("B"); else w.WriteNullValue(); }
        w.WriteEndArray();
        RoundCol(w, "plantTick", s, static r => r.PlantTick);
        RoundCol(w, "planter", s, static r => r.Planter);
        RoundCol(w, "defuser", s, static r => r.Defuser);
        w.WriteStartArray("ctSetup");
        for (int i = 0; i < n; i++)
        {
            var r = s.Round(i);
            if (!r.HasCtSetup) { w.WriteNullValue(); continue; }
            w.WriteStartArray(); foreach (int c in r.CtSetup) w.WriteNumberValue(c); w.WriteEndArray();
        }
        w.WriteEndArray();
        w.WriteStartArray("score");
        for (int i = 0; i < n; i++)
        {
            var r = s.Round(i);
            if (r.ScoreT == Nil.V && r.ScoreCt == Nil.V) w.WriteNullValue();
            else { w.WriteStartArray(); Int(w, r.ScoreT); Int(w, r.ScoreCt); w.WriteEndArray(); }
        }
        w.WriteEndArray();
        PerPlayer(w, "side", s, np, static r => r.Side);
        PerPlayer(w, "equip", s, np, static r => r.Equip);
        PerPlayer(w, "money", s, np, static r => r.Money);
        // Optional economy fields beyond schema v1: equipment kept at round end and survive-with-primary.
        PerPlayer(w, "equipEnd", s, np, static r => r.EquipEnd);
        PerPlayer(w, "survPrimary", s, np, static r => r.SurvPrimary);
        // Optional utility-economy fields: grenades bought (counts by type) and money spent on them; null when the player was absent.
        w.WriteStartArray("utilBought");
        for (int i = 0; i < n; i++)
        {
            var r = s.Round(i);
            w.WriteStartArray();
            for (int pi = 0; pi < np; pi++)
            {
                if (pi >= Limits.MaxPlayers || r.Side[pi] == Nil.V) { w.WriteNullValue(); continue; }
                w.WriteStartArray();
                for (int t = 0; t < UtilCounts.Types; t++) w.WriteNumberValue(r.UtilBought[pi * UtilCounts.Types + t]);
                w.WriteEndArray();
            }
            w.WriteEndArray();
        }
        w.WriteEndArray();
        w.WriteStartArray("utilSpent");
        for (int i = 0; i < n; i++)
        {
            var r = s.Round(i);
            w.WriteStartArray();
            for (int pi = 0; pi < np; pi++) Int(w, pi < Limits.MaxPlayers && r.Side[pi] != Nil.V ? r.UtilSpent[pi] : Nil.V);
            w.WriteEndArray();
        }
        w.WriteEndArray();
        w.WriteEndObject();
    }

    private static void WriteRecon(Utf8JsonWriter w, MatchStore s)
    {
        var m = s.Meta;
        w.WriteStartObject("recon");
        var rr = s.ReconRounds.Span;
        w.WriteStartObject("rounds");
        Col(w, "ri", rr, static r => r.Ri); Col(w, "checked", rr, static r => r.Checked);
        Col(w, "kOk", rr, static r => r.KillsOk); Col(w, "dOk", rr, static r => r.DeathsOk);
        Col(w, "aOk", rr, static r => r.AssistsOk); Col(w, "dmgOk", rr, static r => r.DamageOk);
        Col(w, "missing", rr, static r => r.Missing);
        w.WriteEndObject();
        var mm = s.Mismatches.Span;
        w.WriteStartObject("mismatch");
        Col(w, "ri", mm, static r => r.Ri); Col(w, "pi", mm, static r => r.Pi);
        w.WriteStartArray("field"); foreach (ref readonly var r in mm) w.WriteStringValue(Recon.FieldNames[(int)r.Field]); w.WriteEndArray();
        Col(w, "ours", mm, static r => r.Ours); Col(w, "game", mm, static r => r.Game); Col(w, "hits", mm, static r => r.Hits);
        w.WriteEndObject();
        IntArray(w, "partial", m.PartialRounds);
        IntArray(w, "unknownResult", m.UnknownResults);
        w.WriteNumber("capUnknown", s.CapUnknown);
        w.WriteStartObject("dropped");
        w.WriteNumber("kills", s.TotalDropped("kills", s.Kills.Dropped));
        w.WriteNumber("damage", s.TotalDropped("damage", s.Damage.Dropped));
        w.WriteNumber("blinds", s.TotalDropped("blinds", s.Blinds.Dropped));
        w.WriteNumber("grenades", s.TotalDropped("grenades", s.Grenades.Dropped));
        w.WriteNumber("throws", s.TotalDropped("throws", s.Throws.Dropped));
        w.WriteNumber("pos", s.TotalDropped("pos", s.Pos.Dropped));
        w.WriteNumber("engagements", s.TotalDropped("engagements", s.Engagements.Dropped));
        w.WriteNumber("shots", s.TotalDropped("shots", s.Shots.Dropped));
        w.WriteEndObject();
        w.WriteEndObject();
    }

    private static void WritePerf(Utf8JsonWriter w, MatchStore s)
    {
        var p = s.Perf.Span;
        w.WriteStartObject("perf");
        Col(w, "ri", p, static r => r.Ri);
        Col(w, "ticks", p, static r => r.Ticks);
        Dbl(w, "tickAvgUs", p, static r => r.TickAvgUs);
        Dbl(w, "tickMaxUs", p, static r => r.TickMaxUs);
        Col(w, "events", p, static r => r.Events);
        Dbl(w, "evAvgUs", p, static r => r.EventAvgUs);
        Dbl(w, "evMaxUs", p, static r => r.EventMaxUs);
        w.WriteStartArray("evMaxName"); foreach (ref readonly var r in p) { if (r.EventMaxName == null) w.WriteNullValue(); else w.WriteStringValue(r.EventMaxName); } w.WriteEndArray();
        w.WriteStartArray("tickAllocB"); foreach (ref readonly var r in p) w.WriteNumberValue(r.TickAllocBytes); w.WriteEndArray();
        w.WriteStartArray("evAllocB"); foreach (ref readonly var r in p) w.WriteNumberValue(r.EventAllocBytes); w.WriteEndArray();
        Col(w, "gen0", p, static r => r.Gen0);
        w.WriteStartObject("write");
        w.WriteNumber("lastMs", Math.Round(s.LastWriteMs, 2));
        w.WriteNumber("maxMs", Math.Round(s.MaxWriteMs, 2));
        w.WriteNumber("lastBytes", s.LastBytes);
        w.WriteEndObject();
        w.WriteEndObject();
    }

    private static string OutcomeName(Outcome o) => o switch { Outcome.Kill => "kill", Outcome.Died => "died", _ => "none" };

    private static void Int(Utf8JsonWriter w, int v)
    {
        if (v == Nil.V) w.WriteNullValue(); else w.WriteNumberValue(v);
    }

    private static void IntProp(Utf8JsonWriter w, string name, int v)
    {
        if (v == Nil.V) w.WriteNull(name); else w.WriteNumber(name, v);
    }

    private static void StrOrNull(Utf8JsonWriter w, string name, string? v)
    {
        if (v == null) w.WriteNull(name); else w.WriteString(name, v);
    }

    private static void StrArray(Utf8JsonWriter w, string name, string[] v)
    {
        w.WriteStartArray(name); foreach (var x in v) w.WriteStringValue(x); w.WriteEndArray();
    }

    private static void IntArray(Utf8JsonWriter w, string name, int[] v)
    {
        w.WriteStartArray(name); foreach (var x in v) Int(w, x); w.WriteEndArray();
    }

    private static void Triple(Utf8JsonWriter w, int x, int y, int z)
    {
        if (x == Nil.V) { w.WriteNullValue(); return; }
        w.WriteStartArray(); w.WriteNumberValue(x); w.WriteNumberValue(y); w.WriteNumberValue(z); w.WriteEndArray();
    }

    private static void Util(Utf8JsonWriter w, in UtilCounts u)
    {
        if (!u.Known) { w.WriteNullValue(); return; }
        w.WriteStartArray();
        for (int t = 0; t < UtilCounts.Types; t++) w.WriteNumberValue(u[t]);
        w.WriteEndArray();
    }

    private static void Pair(Utf8JsonWriter w, int a, int b)
    {
        if (a == Nil.V) { w.WriteNullValue(); return; }
        w.WriteStartArray(); w.WriteNumberValue(a); Int(w, b); w.WriteEndArray();
    }

    private static void Col<T>(Utf8JsonWriter w, string name, ReadOnlySpan<T> rows, Func<T, int> get)
    {
        w.WriteStartArray(name);
        foreach (var r in rows) Int(w, get(r));
        w.WriteEndArray();
    }

    private static void Dbl<T>(Utf8JsonWriter w, string name, ReadOnlySpan<T> rows, Func<T, double> get)
    {
        w.WriteStartArray(name);
        foreach (var r in rows) w.WriteNumberValue(Math.Round(get(r), 2));
        w.WriteEndArray();
    }

    private static void RoundCol(Utf8JsonWriter w, string name, MatchStore s, Func<RoundRow, int> get)
    {
        w.WriteStartArray(name);
        for (int i = 0; i < s.RoundCount; i++) Int(w, get(s.Round(i)));
        w.WriteEndArray();
    }

    private static void PerPlayer(Utf8JsonWriter w, string name, MatchStore s, int np, Func<RoundRow, int[]> get)
    {
        w.WriteStartArray(name);
        for (int i = 0; i < s.RoundCount; i++)
        {
            var a = get(s.Round(i));
            w.WriteStartArray();
            for (int pi = 0; pi < np; pi++) Int(w, pi < a.Length ? a[pi] : Nil.V);
            w.WriteEndArray();
        }
        w.WriteEndArray();
    }

    // ---- decode -----------------------------------------------------------------------------

    /// <summary>Reads a file written by <see cref="Write"/> into <paramref name="s"/> (cleared first). Throws on malformed input.</summary>
    public static void Read(Stream input, MatchStore s)
    {
        s.Clear();
        using var doc = JsonDocument.Parse(input);
        var root = doc.RootElement;
        int v = root.GetProperty("v").GetInt32();
        if (v != Version) throw new InvalidDataException($"Match file schema version {v}, expected {Version}.");
        var m = new MatchMeta
        {
            Id = root.GetProperty("id").GetString() ?? "",
            Map = root.GetProperty("map").GetString() ?? "",
            StartUtc = root.GetProperty("startUtc").GetString() ?? "",
            EndUtc = OptString(root, "endUtc"),
            Status = root.GetProperty("status").GetString() ?? "inprogress",
            FirstFullRound = root.GetProperty("firstFullRound").GetInt32(),
            Human = OptInt(root.GetProperty("human")),
            Weapons = Strings(root.GetProperty("weapons")),
            Places = Strings(root.GetProperty("places")),
        };
        var env = root.GetProperty("env");
        m.Env = new EnvInfo
        {
            Plugin = env.GetProperty("plugin").GetString() ?? "",
            Cssharp = OptString(env, "cssharp"),
            Game = OptString(env, "game"),
            TickRate = OptInt(env.GetProperty("tickrate")),
            MaxRounds = OptInt(env.GetProperty("maxrounds")),
            BotDifficulty = OptInt(env.GetProperty("botDifficulty")),
        };
        var pl = root.GetProperty("players");
        var keys = Strings(pl.GetProperty("key"));
        var names = Strings(pl.GetProperty("name"));
        var isBot = pl.GetProperty("isBot");
        var ss = Ints(pl.GetProperty("startSide"));
        m.Players = new PlayerInfo[keys.Length];
        for (int i = 0; i < keys.Length; i++)
            m.Players[i] = new PlayerInfo { Key = keys[i], Name = names[i], IsBot = isBot[i].GetBoolean(), StartSide = ss[i] };

        var recon = root.GetProperty("recon");
        m.PartialRounds = Ints(recon.GetProperty("partial"));
        m.UnknownResults = Ints(recon.GetProperty("unknownResult"));
        s.CapUnknown = recon.GetProperty("capUnknown").GetInt32();
        foreach (var dp in recon.GetProperty("dropped").EnumerateObject())
            if (dp.Value.GetInt32() > 0) s.DroppedGame[dp.Name] = dp.Value.GetInt32();
        if (root.TryGetProperty("resume", out var res))
        {
            m.GameStart = res.GetProperty("gameStart").GetSingle();
            m.NextBurst = res.GetProperty("nextBurst").GetInt32();
        }
        s.Meta = m;

        ReadRounds(root.GetProperty("rounds"), s);
        ReadKills(root.GetProperty("kills"), s);
        ReadDamage(root.GetProperty("damage"), s);
        ReadBlinds(root.GetProperty("blinds"), s);
        ReadGrenades(root.GetProperty("grenades"), s);
        ReadThrows(root.GetProperty("throws"), s);
        ReadPos(root.GetProperty("pos"), s);
        var aim = root.GetProperty("aim");
        ReadEngagements(aim.GetProperty("engagements"), s);
        ReadShots(aim.GetProperty("shots"), s);
        ReadRecon(recon, s);
        ReadPerf(root.GetProperty("perf"), s);
        m.GrenadeCount = s.Grenades.Count;
        m.ThrowCount = s.Throws.Count;
    }

    private static void ReadRounds(JsonElement r, MatchStore s)
    {
        var win = Ints(r.GetProperty("winSide"));
        var how = r.GetProperty("how");
        var freeze = Ints(r.GetProperty("freezeTick"));
        var dur = Ints(r.GetProperty("durTicks"));
        var site = r.GetProperty("bombSite");
        var plant = Ints(r.GetProperty("plantTick"));
        var planter = Ints(r.GetProperty("planter"));
        var defuser = Ints(r.GetProperty("defuser"));
        var ct = r.GetProperty("ctSetup");
        var score = r.GetProperty("score");
        var side = r.GetProperty("side"); var equip = r.GetProperty("equip"); var money = r.GetProperty("money");
        r.TryGetProperty("equipEnd", out var equipEnd);
        r.TryGetProperty("survPrimary", out var surv);
        r.TryGetProperty("utilBought", out var ub);
        r.TryGetProperty("utilSpent", out var us);
        var row = new RoundRow();
        for (int i = 0; i < win.Length; i++)
        {
            row.Reset(i);
            row.WinSide = win[i];
            row.How = how[i].ValueKind == JsonValueKind.Null ? Nil.V : Array.IndexOf(RoundResult.HowNames, how[i].GetString());
            if (row.How < 0) throw new InvalidDataException($"Unknown round 'how' value '{how[i].GetString()}' in round {i}.");
            row.FreezeTick = freeze[i]; row.DurTicks = dur[i];
            row.BombSite = site[i].ValueKind == JsonValueKind.Null ? Nil.V : site[i].GetString() == "B" ? 1 : 0;
            row.PlantTick = plant[i]; row.Planter = planter[i]; row.Defuser = defuser[i];
            if (ct[i].ValueKind != JsonValueKind.Null)
            {
                row.HasCtSetup = true;
                int j = 0;
                foreach (var c in ct[i].EnumerateArray()) row.CtSetup[j++] = c.GetInt32();
            }
            if (score[i].ValueKind != JsonValueKind.Null)
            {
                row.ScoreT = OptInt(score[i][0]);
                row.ScoreCt = OptInt(score[i][1]);
            }
            FillPerPlayer(side[i], row.Side);
            FillPerPlayer(equip[i], row.Equip);
            FillPerPlayer(money[i], row.Money);
            if (equipEnd.ValueKind == JsonValueKind.Array) FillPerPlayer(equipEnd[i], row.EquipEnd);
            if (surv.ValueKind == JsonValueKind.Array) FillPerPlayer(surv[i], row.SurvPrimary);
            if (ub.ValueKind == JsonValueKind.Array)
            {
                int pi = 0;
                foreach (var cell in ub[i].EnumerateArray())
                {
                    if (cell.ValueKind == JsonValueKind.Array && pi < Limits.MaxPlayers)
                    {
                        int t = 0;
                        foreach (var c in cell.EnumerateArray()) { if (t < UtilCounts.Types) row.UtilBought[pi * UtilCounts.Types + t] = c.GetInt32(); t++; }
                    }
                    pi++;
                }
            }
            if (us.ValueKind == JsonValueKind.Array)
            {
                FillPerPlayer(us[i], row.UtilSpent);
                for (int pi = 0; pi < Limits.MaxPlayers; pi++) if (row.Side[pi] == Nil.V) row.UtilSpent[pi] = 0;
            }
            s.SetRound(row);
        }
    }

    private static void FillPerPlayer(JsonElement arr, int[] dest)
    {
        int j = 0;
        foreach (var x in arr.EnumerateArray()) { if (j < dest.Length) dest[j] = OptInt(x); j++; }
    }

    private static void ReadKills(JsonElement t, MatchStore s)
    {
        var ri = Ints(t.GetProperty("ri")); var tick = Ints(t.GetProperty("tick"));
        var killer = Ints(t.GetProperty("killer")); var victim = Ints(t.GetProperty("victim"));
        var asst = Ints(t.GetProperty("assister")); var fa = Ints(t.GetProperty("flashAssister"));
        var weapon = Ints(t.GetProperty("weapon")); var flags = Ints(t.GetProperty("flags"));
        var kpos = t.GetProperty("kpos"); var vpos = t.GetProperty("vpos"); var state = t.GetProperty("state");
        var nade = Ints(t.GetProperty("nade")); var vutil = t.GetProperty("vUtil");
        for (int i = 0; i < ri.Length; i++)
        {
            var r = new KillRow
            {
                Ri = ri[i], Tick = tick[i], Killer = killer[i], Victim = victim[i], Assister = asst[i], FlashAssister = fa[i],
                Weapon = weapon[i], Flags = flags[i],
            };
            Triple(kpos[i], out r.KX, out r.KY, out r.KZ);
            Triple(vpos[i], out r.VX, out r.VY, out r.VZ);
            var st = state[i];
            r.CtAlive = OptInt(st[0]); r.TAlive = OptInt(st[1]); r.CtHp = OptInt(st[2]); r.THp = OptInt(st[3]);
            r.CtEquip = OptInt(st[4]); r.TEquip = OptInt(st[5]); r.Planted = OptInt(st[6]); r.SincePlant = OptInt(st[7]);
            r.Nade = nade[i];
            if (vutil[i].ValueKind == JsonValueKind.Array)
            {
                r.VUtil.Known = true;
                int u = 0;
                foreach (var c in vutil[i].EnumerateArray()) { if (u < UtilCounts.Types) r.VUtil[u] = c.GetInt32(); u++; }
            }
            s.Kills.Add(r);
        }
    }

    private static void ReadDamage(JsonElement t, MatchStore s)
    {
        var ri = Ints(t.GetProperty("ri")); var tick = Ints(t.GetProperty("tick"));
        var a = Ints(t.GetProperty("attacker")); var v = Ints(t.GetProperty("victim"));
        var dmg = Ints(t.GetProperty("dmg")); var arm = Ints(t.GetProperty("dmgArmor"));
        var wpn = Ints(t.GetProperty("weapon")); var hg = Ints(t.GetProperty("hitgroup")); var nade = Ints(t.GetProperty("nade"));
        for (int i = 0; i < ri.Length; i++)
            s.Damage.Add(new DamageRow { Ri = ri[i], Tick = tick[i], Attacker = a[i], Victim = v[i], Dmg = dmg[i], DmgArmor = arm[i], Weapon = wpn[i], Hitgroup = hg[i], Nade = nade[i] });
    }

    private static void ReadBlinds(JsonElement t, MatchStore s)
    {
        var ri = Ints(t.GetProperty("ri")); var tick = Ints(t.GetProperty("tick"));
        var a = Ints(t.GetProperty("attacker")); var v = Ints(t.GetProperty("victim")); var ms = Ints(t.GetProperty("ms"));
        var fl = Ints(t.GetProperty("flash"));
        for (int i = 0; i < ri.Length; i++)
            s.Blinds.Add(new BlindRow { Ri = ri[i], Tick = tick[i], Attacker = a[i], Victim = v[i], Ms = ms[i], Flash = fl[i] });
    }

    private static void ReadGrenades(JsonElement t, MatchStore s)
    {
        var ri = Ints(t.GetProperty("ri")); var tick = Ints(t.GetProperty("tick")); var th = Ints(t.GetProperty("thrower"));
        var type = t.GetProperty("type"); var pos = t.GetProperty("pos"); var link = Ints(t.GetProperty("throw"));
        for (int i = 0; i < ri.Length; i++)
        {
            int ty = Array.IndexOf(WeaponNames.GrenadeTypeNames, type[i].GetString());
            if (ty < 0) throw new InvalidDataException($"Unknown grenade type '{type[i].GetString()}'.");
            var r = new GrenadeRow { Ri = ri[i], Tick = tick[i], Thrower = th[i], Type = (GrenadeType)ty, Throw = link[i] };
            Triple(pos[i], out r.X, out r.Y, out r.Z);
            s.Grenades.Add(r);
        }
    }

    private static void ReadThrows(JsonElement t, MatchStore s)
    {
        var ri = Ints(t.GetProperty("ri")); var tick = Ints(t.GetProperty("tick")); var th = Ints(t.GetProperty("thrower"));
        var type = t.GetProperty("type"); var pos = t.GetProperty("pos");
        for (int i = 0; i < ri.Length; i++)
        {
            int ty = Array.IndexOf(WeaponNames.UtilTypeNames, type[i].GetString());
            if (ty < 0) throw new InvalidDataException($"Unknown throw type '{type[i].GetString()}'.");
            var r = new ThrowRow { Ri = ri[i], Tick = tick[i], Thrower = th[i], Type = (UtilType)ty };
            Triple(pos[i], out r.X, out r.Y, out r.Z);
            s.Throws.Add(r);
        }
    }

    private static void ReadPos(JsonElement t, MatchStore s)
    {
        var ri = Ints(t.GetProperty("ri")); var tick = Ints(t.GetProperty("tick")); var pi = Ints(t.GetProperty("pi"));
        var x = Ints(t.GetProperty("x")); var y = Ints(t.GetProperty("y")); var z = Ints(t.GetProperty("z"));
        var place = Ints(t.GetProperty("place")); var alive = Ints(t.GetProperty("alive"));
        for (int i = 0; i < ri.Length; i++)
            s.Pos.Add(new PosRow { Ri = ri[i], Tick = tick[i], Pi = pi[i], X = x[i], Y = y[i], Z = z[i], Place = place[i], Alive = alive[i] });
    }

    private static void ReadEngagements(JsonElement t, MatchStore s)
    {
        var ri = Ints(t.GetProperty("ri")); var en = Ints(t.GetProperty("enemy")); var tv = Ints(t.GetProperty("tVis"));
        var av = Ints(t.GetProperty("angVis")); var ay = Ints(t.GetProperty("angVisYaw")); var ap = Ints(t.GetProperty("angVisPitch"));
        var dist = Ints(t.GetProperty("dist")); var tas = Ints(t.GetProperty("tAimStart")); var tfs = Ints(t.GetProperty("tFirstShot"));
        var tfd = Ints(t.GetProperty("tFirstDmg")); var te = Ints(t.GetProperty("tEnd")); var oc = t.GetProperty("outcome");
        for (int i = 0; i < ri.Length; i++)
        {
            var o = oc[i].GetString() switch
            {
                "kill" => Outcome.Kill,
                "died" => Outcome.Died,
                "none" => Outcome.None,
                var other => throw new InvalidDataException($"Unknown engagement outcome '{other}'."),
            };
            s.Engagements.Add(new EngagementRow
            {
                Ri = ri[i], Enemy = en[i], TVis = tv[i], AngVis = av[i], AngVisYaw = ay[i], AngVisPitch = ap[i], Dist = dist[i],
                TAimStart = tas[i], TFirstShot = tfs[i], TFirstDmg = tfd[i], TEnd = te[i], Outcome = o,
            });
        }
    }

    private static void ReadShots(JsonElement t, MatchStore s)
    {
        var ri = Ints(t.GetProperty("ri")); var tick = Ints(t.GetProperty("tick")); var wpn = Ints(t.GetProperty("weapon"));
        var burst = Ints(t.GetProperty("burst")); var idx = Ints(t.GetProperty("idx"));
        var speed = Ints(t.GetProperty("speed")); var max = Ints(t.GetProperty("maxSpeed"));
        var scoped = t.GetProperty("scoped"); var ducked = t.GetProperty("ducked");
        var target = Ints(t.GetProperty("target")); var err = t.GetProperty("aimErr"); var imp = t.GetProperty("impact");
        var hit = Ints(t.GetProperty("hit"));
        for (int i = 0; i < ri.Length; i++)
        {
            var r = new ShotRow
            {
                Ri = ri[i], Tick = tick[i], Weapon = wpn[i], Burst = burst[i], Idx = idx[i], Speed = speed[i], MaxSpeed = max[i],
                Scoped = scoped[i].GetBoolean(), Ducked = ducked[i].GetBoolean(), Target = target[i], Hit = hit[i],
            };
            Pair(err[i], out r.AimErrYaw, out r.AimErrPitch);
            Pair(imp[i], out r.ImpYaw, out r.ImpPitch);
            s.Shots.Add(r);
        }
    }

    private static void ReadRecon(JsonElement recon, MatchStore s)
    {
        var r = recon.GetProperty("rounds");
        var ri = Ints(r.GetProperty("ri")); var ch = Ints(r.GetProperty("checked"));
        var k = Ints(r.GetProperty("kOk")); var d = Ints(r.GetProperty("dOk")); var a = Ints(r.GetProperty("aOk"));
        var dm = Ints(r.GetProperty("dmgOk")); var mi = Ints(r.GetProperty("missing"));
        for (int i = 0; i < ri.Length; i++)
            s.ReconRounds.Add(new ReconRound { Ri = ri[i], Checked = ch[i], KillsOk = k[i], DeathsOk = d[i], AssistsOk = a[i], DamageOk = dm[i], Missing = mi[i] });
        var m = recon.GetProperty("mismatch");
        var mri = Ints(m.GetProperty("ri")); var mpi = Ints(m.GetProperty("pi")); var f = m.GetProperty("field");
        var ours = Ints(m.GetProperty("ours")); var game = Ints(m.GetProperty("game")); var hits = Ints(m.GetProperty("hits"));
        for (int i = 0; i < mri.Length; i++)
        {
            int fi = Array.IndexOf(Recon.FieldNames, f[i].GetString());
            if (fi < 0) throw new InvalidDataException($"Unknown recon field '{f[i].GetString()}'.");
            s.Mismatches.Add(new ReconMismatch { Ri = mri[i], Pi = mpi[i], Field = (ReconField)fi, Ours = ours[i], Game = game[i], Hits = hits[i] });
        }
    }

    private static void ReadPerf(JsonElement p, MatchStore s)
    {
        var ri = Ints(p.GetProperty("ri")); var ticks = Ints(p.GetProperty("ticks")); var ev = Ints(p.GetProperty("events"));
        var tavg = p.GetProperty("tickAvgUs"); var tmax = p.GetProperty("tickMaxUs");
        var eavg = p.GetProperty("evAvgUs"); var emax = p.GetProperty("evMaxUs"); var ename = p.GetProperty("evMaxName");
        var ta = p.GetProperty("tickAllocB"); var ea = p.GetProperty("evAllocB"); var g0 = Ints(p.GetProperty("gen0"));
        for (int i = 0; i < ri.Length; i++)
            s.Perf.Add(new PerfRow
            {
                Ri = ri[i], Ticks = ticks[i], Events = ev[i], Gen0 = g0[i],
                TickAvgUs = tavg[i].GetDouble(), TickMaxUs = tmax[i].GetDouble(), EventAvgUs = eavg[i].GetDouble(), EventMaxUs = emax[i].GetDouble(),
                EventMaxName = ename[i].ValueKind == JsonValueKind.Null ? null : ename[i].GetString(),
                TickAllocBytes = ta[i].GetInt64(), EventAllocBytes = ea[i].GetInt64(),
            });
        var w = p.GetProperty("write");
        s.LastWriteMs = w.GetProperty("lastMs").GetDouble();
        s.MaxWriteMs = w.GetProperty("maxMs").GetDouble();
        s.LastBytes = w.GetProperty("lastBytes").GetInt64();
    }

    private static int OptInt(JsonElement e) => e.ValueKind == JsonValueKind.Null ? Nil.V : e.GetInt32();

    private static string? OptString(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;

    private static int[] Ints(JsonElement arr)
    {
        var a = new int[arr.GetArrayLength()];
        int i = 0;
        foreach (var x in arr.EnumerateArray()) a[i++] = OptInt(x);
        return a;
    }

    private static string[] Strings(JsonElement arr)
    {
        var a = new string[arr.GetArrayLength()];
        int i = 0;
        foreach (var x in arr.EnumerateArray()) a[i++] = x.GetString() ?? "";
        return a;
    }

    private static void Triple(JsonElement e, out int x, out int y, out int z)
    {
        if (e.ValueKind == JsonValueKind.Null) { x = y = z = Nil.V; return; }
        x = e[0].GetInt32(); y = e[1].GetInt32(); z = e[2].GetInt32();
    }

    private static void Pair(JsonElement e, out int a, out int b)
    {
        if (e.ValueKind == JsonValueKind.Null) { a = b = Nil.V; return; }
        a = e[0].GetInt32(); b = OptInt(e[1]);
    }

    public static string IsoUtc(DateTime t) => t.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
}
