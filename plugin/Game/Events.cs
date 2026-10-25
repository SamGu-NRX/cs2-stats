using System.Diagnostics;
using BotMatchStats.Core;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using Microsoft.Extensions.Logging;

namespace BotMatchStats.Game;

public sealed partial class BotMatchStatsPlugin
{
    // Every handler measures its own time and allocations into the per-round perf row. Handlers
    // return early unless a round is being recorded, so warmup costs almost nothing.

    private long _evT0, _evA0;

    private void EvBegin()
    {
        _evT0 = Stopwatch.GetTimestamp();
        _evA0 = GC.GetAllocatedBytesForCurrentThread();
    }

    private HookResult EvEnd(string name)
    {
        _perf.Event(Stopwatch.GetTimestamp() - _evT0, GC.GetAllocatedBytesForCurrentThread() - _evA0, name);
        return HookResult.Continue;
    }

    private bool Recording => _rec is { RoundActive: true } && !_needInit;

    private void EvError(string name, Exception ex) => Log(LogLevel.Error, $"{name} handler failed: {ex}");

    private HookResult OnRoundStart(EventRoundStart e, GameEventInfo info)
    {
        if (_rec == null || _needInit || _disabled || _rules == null) return HookResult.Continue;
        if (_scanPending)
        {
            // Not capturing yet, but a restart here changes which match the pending scan must find.
            var rl = _rules;
            if (Lifecycle.ScanStale(rl.WarmupPeriod, rl.TotalRoundsPlayed, rl.GameStartTime, _scanRounds, _scanGameStart))
                Rescan("game changed during scan");
            _winPanelSeen = false;
            return HookResult.Continue;
        }
        EvBegin();
        try
        {
            var rec = _rec;
            _tick = Server.TickCount;
            var rules = _rules;
            bool warm = rules.WarmupPeriod;
            int r = rules.TotalRoundsPlayed;
            float gs = rules.GameStartTime;
            if (rec.Capturing)
            {
                // mp_restartgame and a return to warmup both reset the round counter, so the index
                // alone detects them. GameStartTime is not compared: when the engine sets it relative
                // to round 0's round_start is unverified, and a late write would fake a restart.
                // LastRound includes rounds loaded from the file, so this also holds right after a resume.
                bool restart = rec.IsRestart(r, warm);
                if (!restart) rec.Meta.GameStart = gs;
                if (restart)
                {
                    _finalizeAt = Nil.V;
                    _matchEndAt = Nil.V;
                    _winPanelSeen = false;
                    Log(LogLevel.Information, $"game restarted (round {r}, warmup={warm}); closing capture as restarted");
                    rec.EndCapture("restarted", MatchCodec.IsoUtc(DateTime.UtcNow), _tick);
                }
                else
                {
                    _finalizeAt = Nil.V;
                    FinalizeRound();
                    Reconcile();
                    rec.Flush();
                    if (rec.LastRound != Nil.V) AddPriorRounds(rec.LastRound + 1, r);
                    rec.BeginRound(r, _tick, _teamT?.Score ?? Nil.V, _teamCt?.Score ?? Nil.V, partial: false, Nil.V);
                    return EvEnd("round_start");
                }
            }
            if (!warm && _humanSlot >= 0)
            {
                StartCapture(r);
                AddPriorRounds(0, r);
                rec.BeginRound(r, _tick, _teamT?.Score ?? Nil.V, _teamCt?.Score ?? Nil.V, partial: false, Nil.V);
            }
        }
        catch (Exception ex) { EvError("round_start", ex); }
        return EvEnd("round_start");
    }

    private HookResult OnFreezeEnd(EventRoundFreezeEnd e, GameEventInfo info)
    {
        if (!Recording) return HookResult.Continue;
        EvBegin();
        try
        {
            var rec = _rec!;
            _tick = Server.TickCount;
            RefreshSlots(true);
            // m_unCurrentEquipmentValue is trusted unless every bot reads 0, which would record false ecos;
            // then this round's values are rebuilt from inventory for every player.
            bool anyBotEquip = false, anyBot = false;
            for (int slot = 0; slot < MaxSlots; slot++)
            {
                ref var s = ref _slots[slot];
                if (!s.Valid || s.Pi == Nil.V || !s.IsBot || (s.Team != 2 && s.Team != 3)) continue;
                nint pawn = PawnOfSlot(slot);
                if (pawn == 0 || !Mem.Alive(pawn)) continue;
                anyBot = true;
                anyBotEquip |= Mem.EquipValue(pawn) > 0;
            }
            bool wasInventory = _equipFromInventory;
            _equipFromInventory = anyBot && !anyBotEquip;
            if (_equipFromInventory && !wasInventory)
                Log(LogLevel.Warning, "every bot reads 0 for m_unCurrentEquipmentValue at freeze end; equipment values come from inventory prices instead.");
            rec.SetEquipSource(_equipFromInventory ? Recorder.EquipFromInventory : Recorder.EquipFromPawn);
            if (_humanSlot >= 0)
            {
                nint hp = PawnOfSlot(_humanSlot);
                if (hp != 0) rec.SetHumanEntities(_humanSlot, _humanSlot + 1, Mem.IndexOf(hp));
            }
            for (int slot = 0; slot < MaxSlots; slot++)
            {
                ref var s = ref _slots[slot];
                if (!s.Valid || s.Pi == Nil.V || (s.Team != 2 && s.Team != 3)) continue;
                nint pawn = PawnOfSlot(slot);
                bool alive = pawn != 0 && Mem.Alive(pawn);
                int hp = pawn != 0 ? Mem.Read<int>(pawn, Mem.Health) : 0;
                int equip = pawn != 0 ? EquipOf(pawn) : Nil.V;
                int money = new CCSPlayerController(s.Ctrl).InGameMoneyServices?.Account ?? Nil.V;
                rec.SetFreezePlayer(s.Pi, s.Team, money, equip, hp, alive);
            }
            rec.FreezeEnd(_tick);
        }
        catch (Exception ex) { EvError("round_freeze_end", ex); }
        return EvEnd("round_freeze_end");
    }

    private HookResult OnRoundEnd(EventRoundEnd e, GameEventInfo info)
    {
        if (!Recording || _rec!.RoundFinalized) return HookResult.Continue;
        EvBegin();
        try
        {
            var rec = _rec;
            _tick = Server.TickCount;
            rec.RoundEnd(_tick, e.Winner, e.Reason);
            for (int slot = 0; slot < MaxSlots; slot++)
            {
                ref var s = ref _slots[slot];
                if (!s.Valid || s.Pi == Nil.V || (s.Team != 2 && s.Team != 3)) continue;
                nint pawn = PawnOfSlot(slot);
                bool alive = pawn != 0 && Mem.Alive(pawn);
                rec.SetRoundEndEconomy(s.Pi, alive ? EquipOf(pawn) : 0, alive && HasPrimary(slot));
            }
            _finalizeAt = _tick + rec.TickRate;
        }
        catch (Exception ex) { EvError("round_end", ex); }
        return EvEnd("round_end");
    }

    private bool HasPrimary(int slot)
    {
        var pawn = new CCSPlayerController(_slots[slot].Ctrl).PlayerPawn.Value;
        var weapons = pawn?.WeaponServices?.MyWeapons;
        if (weapons == null) return false;
        foreach (var h in weapons)
        {
            var w = h.Value;
            if (w == null || !w.IsValid) continue;
            if (w.As<CCSWeaponBase>().VData?.GearSlot == gear_slot_t.GEAR_SLOT_RIFLE) return true;
        }
        return false;
    }

    private HookResult OnWinPanel(EventCsWinPanelMatch e, GameEventInfo info)
    {
        // Remembered even when not capturing, so a capture resumed afterwards knows the match is over.
        _winPanelSeen = true;
        if (_rec is not { Capturing: true }) return HookResult.Continue;
        EvBegin();
        // The last round's per-round stats settle after the event; the snapshot probe read them 1 s later.
        _matchEndAt = Server.TickCount + _rec.TickRate;
        return EvEnd("cs_win_panel_match");
    }

    private HookResult OnDeathPre(EventPlayerDeath e, GameEventInfo info)
    {
        if (!Recording) return HookResult.Continue;
        EvBegin();
        try
        {
            // Read the victim's grenades before death handling can drop them.
            int slot = SlotOfEventPlayer(e, "userid");
            nint pawn = PawnOfSlot(slot);
            if (pawn != 0)
            {
                ref var s = ref _slots[slot];
                s.DeathUtil = Mem.Utility(pawn, _ammoSlot, out s.DeathWeapons);
                s.DeathUtilTick = Server.TickCount;
                s.DeathEquip = EquipOf(pawn);
                s.DeathEquipTick = s.DeathUtilTick;
            }
        }
        catch (Exception ex) { EvError("player_death(pre)", ex); }
        return EvEnd("player_death_pre");
    }

    private HookResult OnDeath(EventPlayerDeath e, GameEventInfo info)
    {
        if (!Recording) return HookResult.Continue;
        EvBegin();
        try
        {
            var rec = _rec!;
            int tick = Server.TickCount;
            var victim = e.Userid;
            int v = PiOf(victim);
            if (v == Nil.V) return EvEnd("player_death");
            var attacker = e.Attacker;
            int a = PiOf(attacker);
            int assist = PiOf(e.Assister);
            string weapon = WeaponNames.Strip(e.Weapon);
            int flags = 0;
            if (e.Headshot) flags |= Recorder.KillFlagHeadshot;
            if (e.Penetrated > 0) flags |= Recorder.KillFlagWallbang;
            if (e.Thrusmoke) flags |= Recorder.KillFlagSmoke;
            if (e.Attackerblind) flags |= Recorder.KillFlagBlind;
            if (e.Noscope) flags |= Recorder.KillFlagNoscope;
            if (e.Attackerinair) flags |= Recorder.KillFlagInAir;

            int vslot = victim!.Slot;
            ref var vs = ref _slots[vslot];
            var k = new KillInput
            {
                Tick = tick, Killer = a, Victim = v, Assister = assist, AssistedFlash = e.Assistedflash,
                Weapon = weapon.Length == 0 ? Nil.V : rec.Weapons.Get(weapon), Flags = flags,
                NadeType = WeaponNames.NadeSourceOf(weapon), Bullet = WeaponNames.IsBulletWeapon(weapon),
                VictimUtil = vs.DeathUtilTick == tick && vs.DeathWeapons > 0 ? vs.DeathUtil : vs.Util,
                VictimBody = BodyPi(vslot),
                KillerBody = attacker != null && attacker.IsValid ? BodyPi(attacker.Slot) : Nil.V,
            };
            // The victim's own value comes from the pre-hook, so a weapon picked up just before death counts.
            if (vs.DeathEquipTick == tick && vs.DeathEquip != Nil.V) rec.SetEquipNow(v, vs.DeathEquip);
            nint vp = PawnOfSlot(vslot);
            if (vp != 0) Mem.Origin(vp, out k.VX, out k.VY, out k.VZ);
            else k.VX = k.VY = k.VZ = float.NaN;
            if (attacker != null && attacker.IsValid)
            {
                nint kp = PawnOfSlot(attacker.Slot);
                if (kp != 0) { Mem.Origin(kp, out k.KX, out k.KY, out k.KZ); k.HasKillerPos = !float.IsNaN(k.KX); }
            }
            // Current equipment of everyone still alive, for the kill state.
            for (int slot = 0; slot < MaxSlots; slot++)
            {
                ref var s = ref _slots[slot];
                if (!s.Valid || s.Pi == Nil.V || slot == vslot) continue;
                nint p = PawnOfSlot(slot);
                if (p != 0 && Mem.Alive(p)) rec.SetEquipNow(s.Pi, EquipOf(p));
            }
            rec.Kill(k);
        }
        catch (Exception ex) { EvError("player_death", ex); }
        return EvEnd("player_death");
    }

    private HookResult OnHurt(EventPlayerHurt e, GameEventInfo info)
    {
        if (!Recording) return HookResult.Continue;
        EvBegin();
        try
        {
            var rec = _rec!;
            int v = PiOf(e.Userid);
            if (v == Nil.V) return EvEnd("player_hurt");
            var attacker = e.Attacker;
            int a = PiOf(attacker);
            string weapon = WeaponNames.Strip(e.Weapon);
            if (a != Nil.V && WeaponNames.NeedsVariantCheck(weapon))
            {
                nint ap = attacker != null && attacker.IsValid ? PawnOfSlot(attacker.Slot) : 0;
                weapon = WeaponNames.HurtVariant(weapon, ap == 0 ? -1 : Mem.ActiveItemDef(ap)) ?? weapon;
            }
            int tick = Server.TickCount;
            rec.Hurt(tick, a, v, e.DmgHealth, e.DmgArmor, e.Health,
                weapon.Length == 0 ? Nil.V : rec.Weapons.Get(weapon), e.Hitgroup,
                WeaponNames.IsBulletWeapon(weapon), WeaponNames.NadeSourceOf(weapon));
            if (a != Nil.V && a == rec.HumanPi)
            {
                // Raw reads only: validation data for IsVisibleToHuman (aim.hitMask).
                nint vp = PawnOfSlot(e.Userid!.Slot);
                if (vp != 0)
                {
                    Mem.SpottedState(vp, out uint m0, out uint m1, out bool spotted);
                    rec.HitMask(tick, a, v, m0, m1, spotted, LosAtHit(vp));
                }
            }
        }
        catch (Exception ex) { EvError("player_hurt", ex); }
        return EvEnd("player_hurt");
    }

    /// <summary>
    /// Line of sight from the human's eye to the victim at the moment of a hit (aim.hitMask.los): 1 when
    /// any of the tracker's points is clear, 0 when all are blocked, Nil when line of sight is off.
    /// Validation data for the 16 Hz signal, at the cost of up to three traces per human hit.
    /// </summary>
    private int LosAtHit(nint victimPawn)
    {
        var probe = _losProbe;
        if (probe == null || !_rec!.Los.Enabled || _humanSlot < 0) return Nil.V;
        nint hp = PawnOfSlot(_humanSlot);
        if (hp == 0) return Nil.V;
        Mem.Origin(hp, out float hx, out float hy, out float hz);
        Mem.Origin(victimPawn, out float vx, out float vy, out float vz);
        if (float.IsNaN(hx) || float.IsNaN(vx)) return Nil.V;
        double ez = hz + Mem.Read<float>(hp, Mem.ViewZ);
        float vview = Mem.Read<float>(victimPawn, Mem.ViewZ);
        probe.SetIgnore(hp);
        foreach (double frac in LosTracker.PointHeights)
        {
            bool? clear = probe.Clear(hx, hy, ez, vx, vy, vz + vview * frac);
            if (clear == null) return Nil.V;
            if (clear.Value) return 1;
        }
        return 0;
    }

    private HookResult OnBlind(EventPlayerBlind e, GameEventInfo info)
    {
        if (!Recording) return HookResult.Continue;
        EvBegin();
        try
        {
            int v = PiOf(e.Userid);
            if (v != Nil.V)
                _rec!.Blind(Server.TickCount, PiOf(e.Attacker), v, (int)Math.Round(e.BlindDuration * 1000f));
        }
        catch (Exception ex) { EvError("player_blind", ex); }
        return EvEnd("player_blind");
    }

    /// <summary>
    /// The shot path. Bots' shots are rejected by comparing the event's controller pointer, without
    /// creating a wrapper; the human's shots read pawn memory directly, and the weapon is resolved
    /// through CSSharp only when the active weapon handle changes.
    /// </summary>
    private HookResult OnWeaponFire(EventWeaponFire e, GameEventInfo info)
    {
        if (!Recording || _humanSlot < 0) return HookResult.Continue;
        nint ctrl = NativeAPI.GetEventPlayerController(e.Handle, "userid");
        if (ctrl == 0 || ctrl != _slots[_humanSlot].Ctrl) return HookResult.Continue;
        EvBegin();
        try
        {
            var rec = _rec!;
            nint pawn = PawnOfSlot(_humanSlot);
            if (pawn == 0) return EvEnd("weapon_fire");
            uint wh = Mem.ActiveWeaponHandle(pawn);
            if (wh != _shotWeaponHandle) ResolveShotWeapon(e, wh);
            if (!_shotIsBullet) return EvEnd("weapon_fire");
            ReadAimFrames();
            rec.Shot(new ShotInput
            {
                Tick = Server.TickCount, Weapon = _shotWeapon, Class = _shotClass, Speed = Mem.HorizontalSpeed(pawn), MaxSpeed = _shotMaxSpeed,
                Scoped = Mem.IsScoped(pawn), Ducked = Mem.IsDucked(pawn),
            });
        }
        catch (Exception ex) { EvError("weapon_fire", ex); }
        return EvEnd("weapon_fire");
    }

    private void ResolveShotWeapon(EventWeaponFire e, uint handle)
    {
        _shotWeaponHandle = handle;
        string name = WeaponNames.Strip(e.Weapon);
        _shotIsBullet = WeaponNames.IsBulletWeapon(name);
        _shotWeapon = _rec!.Weapons.Get(name);
        _shotClass = WeaponNames.ClassOf(name);
        _shotMaxSpeed = Nil.V;
        nint wp = Mem.ByHandle(handle);
        if (wp == 0) return;
        var vdata = new CCSWeaponBase(wp).VData;
        if (vdata != null) _shotMaxSpeed = (int)Math.Round(vdata.MaxSpeed.Values[0]);
    }

    private HookResult OnBulletImpact(EventBulletImpact e, GameEventInfo info)
    {
        if (!Recording || _humanSlot < 0) return HookResult.Continue;
        nint ctrl = NativeAPI.GetEventPlayerController(e.Handle, "userid");
        if (ctrl == 0 || ctrl != _slots[_humanSlot].Ctrl) return HookResult.Continue;
        EvBegin();
        try { _rec!.Impact(Server.TickCount, e.X, e.Y, e.Z); }
        catch (Exception ex) { EvError("bullet_impact", ex); }
        return EvEnd("bullet_impact");
    }

    private HookResult OnGrenadeThrown(EventGrenadeThrown e, GameEventInfo info)
    {
        if (!Recording) return HookResult.Continue;
        EvBegin();
        try
        {
            var c = e.Userid;
            int pi = PiOf(c);
            if (WeaponNames.TryUtilType(e.Weapon, out var type))
            {
                float x = float.NaN, y = float.NaN, z = float.NaN;
                nint pawn = c != null && c.IsValid ? PawnOfSlot(c.Slot) : 0;
                if (pawn != 0) Mem.Origin(pawn, out x, out y, out z);
                _rec!.Throw(Server.TickCount, pi, type, x, y, z);
            }
            else Log(LogLevel.Warning, $"grenade_thrown with unrecognized weapon '{e.Weapon}'");
        }
        catch (Exception ex) { EvError("grenade_thrown", ex); }
        return EvEnd("grenade_thrown");
    }

    private HookResult Detonation(CCSPlayerController? thrower, GrenadeType type, float x, float y, float z, string name, int entityId = Nil.V)
    {
        if (!Recording) return HookResult.Continue;
        EvBegin();
        try { _rec!.Grenade(Server.TickCount, PiOf(thrower), type, x, y, z, entityId); }
        catch (Exception ex) { EvError(name, ex); }
        return EvEnd(name);
    }

    private HookResult OnHe(EventHegrenadeDetonate e, GameEventInfo info) => Detonation(e.Userid, GrenadeType.He, e.X, e.Y, e.Z, "hegrenade_detonate");
    private HookResult OnFlash(EventFlashbangDetonate e, GameEventInfo info) => Detonation(e.Userid, GrenadeType.Flash, e.X, e.Y, e.Z, "flashbang_detonate");
    private HookResult OnSmoke(EventSmokegrenadeDetonate e, GameEventInfo info) => Detonation(e.Userid, GrenadeType.Smoke, e.X, e.Y, e.Z, "smokegrenade_detonate", e.Entityid);

    private HookResult OnSmokeExpired(EventSmokegrenadeExpired e, GameEventInfo info)
    {
        if (!Recording) return HookResult.Continue;
        EvBegin();
        try { _rec!.SmokeExpired(Server.TickCount, e.Entityid); }
        catch (Exception ex) { EvError("smokegrenade_expired", ex); }
        return EvEnd("smokegrenade_expired");
    }
    private HookResult OnDecoy(EventDecoyStarted e, GameEventInfo info) => Detonation(e.Userid, GrenadeType.Decoy, e.X, e.Y, e.Z, "decoy_started");

    /// <summary>inferno_startburn has no userid; the thrower is the inferno entity's owner.</summary>
    private HookResult OnInferno(EventInfernoStartburn e, GameEventInfo info)
    {
        if (!Recording) return HookResult.Continue;
        EvBegin();
        try
        {
            nint inferno = Mem.ByIndex(e.Entityid, out _);
            int slot = inferno != 0 ? Mem.OwnerSlot(inferno) : -1;
            int pi = (uint)slot < MaxSlots ? _slots[slot].Pi : Nil.V;
            _rec!.Grenade(Server.TickCount, pi, GrenadeType.Molotov, e.X, e.Y, e.Z);
        }
        catch (Exception ex) { EvError("inferno_startburn", ex); }
        return EvEnd("inferno_startburn");
    }

    private HookResult OnBombPlanted(EventBombPlanted e, GameEventInfo info)
    {
        if (!Recording) return HookResult.Continue;
        EvBegin();
        try
        {
            // Sites are read once per map (BuildBombSites); the wrapper path is a fallback for a site added later.
            if (!_bombSites.TryGetValue(e.Site, out int site))
            {
                var target = Utilities.GetEntityFromIndex<CBombTarget>(e.Site);
                site = target == null || !target.IsValid ? Nil.V : target.IsBombSiteB ? 1 : 0;
                if (site == Nil.V) Log(LogLevel.Warning, $"bomb_planted site entity {e.Site} is not a bomb target; bombSite is null");
            }
            _rec!.BombPlanted(Server.TickCount, PiOf(e.Userid), site);
        }
        catch (Exception ex) { EvError("bomb_planted", ex); }
        return EvEnd("bomb_planted");
    }

    private HookResult OnBombDefused(EventBombDefused e, GameEventInfo info)
    {
        if (!Recording) return HookResult.Continue;
        EvBegin();
        try { _rec!.BombDefused(Server.TickCount, PiOf(e.Userid)); }
        catch (Exception ex) { EvError("bomb_defused", ex); }
        return EvEnd("bomb_defused");
    }

    /// <summary>Grenade purchases; the price comes from the bought item's VData.</summary>
    private HookResult OnItemPurchase(EventItemPurchase e, GameEventInfo info)
    {
        if (!Recording) return HookResult.Continue;
        EvBegin();
        try
        {
            if (!WeaponNames.TryUtilType(e.Weapon, out var type)) return EvEnd("item_purchase");
            var c = e.Userid;
            int pi = PiOf(c);
            if (pi == Nil.V) return EvEnd("item_purchase");
            string designer = "weapon_" + WeaponNames.Strip(e.Weapon);
            int price = Nil.V;
            var weapons = c!.PlayerPawn.Value?.WeaponServices?.MyWeapons;
            if (weapons != null)
            {
                foreach (var h in weapons)
                {
                    var w = h.Value;
                    if (w == null || !w.IsValid || w.DesignerName != designer) continue;
                    var vd = w.As<CCSWeaponBase>().VData;
                    if (vd == null) break;
                    price = vd.Price;
                    if (_ammoSlot[(int)type] < 0) _ammoSlot[(int)type] = vd.PrimaryAmmoType;
                    break;
                }
            }
            if (price == Nil.V) Log(LogLevel.Warning, $"price of {e.Weapon} bought by {c.PlayerName} not readable; utilSpent is null for that player this round");
            _rec!.UtilBought(pi, type, price);
        }
        catch (Exception ex) { EvError("item_purchase", ex); }
        return EvEnd("item_purchase");
    }

    private HookResult OnPlayerSpawn(EventPlayerSpawn e, GameEventInfo info)
    {
        if (_rec is not { Capturing: true }) return HookResult.Continue;
        EvBegin();
        try
        {
            int pi = PiOf(e.Userid);
            var c = e.Userid;
            if (pi != Nil.V && c != null)
            {
                nint pawn = PawnOfSlot(c.Slot);
                if (pawn != 0) _rec.SetAlive(pi, Mem.Alive(pawn), Mem.Read<int>(pawn, Mem.Health));
            }
            _nextRefresh = 0;
        }
        catch (Exception ex) { EvError("player_spawn", ex); }
        return EvEnd("player_spawn");
    }

    private HookResult OnPlayerTeam(EventPlayerTeam e, GameEventInfo info)
    {
        _nextRefresh = 0;
        return HookResult.Continue;
    }

    private HookResult OnPlayerDisconnect(EventPlayerDisconnect e, GameEventInfo info)
    {
        _nextRefresh = 0;
        if (_rec is not { Capturing: true }) return HookResult.Continue;
        EvBegin();
        try
        {
            var c = e.Userid;
            if (c != null && c.Slot == _humanSlot)
            {
                if (_matchEndAt != Nil.V) { _matchEndAt = Nil.V; EndMatch(); }
                else Abandon("human disconnected");
            }
            else if (c != null && (uint)c.Slot < MaxSlots && _slots[c.Slot].Pi != Nil.V)
            {
                _rec.Leave(Server.TickCount, _slots[c.Slot].Pi);
            }
        }
        catch (Exception ex) { EvError("player_disconnect", ex); }
        return EvEnd("player_disconnect");
    }
}
