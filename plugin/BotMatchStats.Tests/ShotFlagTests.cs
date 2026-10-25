using BotMatchStats.Core;

namespace BotMatchStats.Tests;

public class SmokeRayTests
{
    // Shooter at the origin looking along +Y; sphere radius 144.
    private static bool Hit(double cx, double cy, double cz, double len = 4096) =>
        SmokeRay.SegmentHitsSphere(0, 0, 0, 0, 1, 0, len, cx, cy, cz, SmokeRay.Radius);

    [Fact] public void RayThroughCentre() => Assert.True(Hit(0, 500, 0));
    [Fact] public void RayThroughOffCentre() => Assert.True(Hit(100, 500, -50));
    [Fact] public void TangentDoesNotCount() => Assert.False(Hit(144, 500, 0));
    [Fact] public void JustInsideTangentCounts() => Assert.True(Hit(143.99, 500, 0));
    [Fact] public void MissesToTheSide() => Assert.False(Hit(300, 500, 0));
    [Fact] public void SphereBehindShooter() => Assert.False(Hit(0, -500, 0));
    [Fact] public void SphereBeyondTarget() => Assert.False(Hit(0, 500, 0, len: 300)); // entry at 356 > 300
    [Fact] public void TargetInsideSmoke() => Assert.True(Hit(0, 500, 0, len: 400));  // entry at 356 < 400
    [Fact] public void ShooterInsideSmoke() => Assert.True(Hit(0, 50, 0, len: 10));
    [Fact] public void SphereBeyondMaxRange() => Assert.False(Hit(0, 4096 + 145, 0));
}

public class WeaponClassTests
{
    [Theory]
    [InlineData("ak47", WeaponClass.Rifle)]
    [InlineData("m4a1", WeaponClass.Rifle)]
    [InlineData("m4a1_silencer", WeaponClass.Rifle)]
    [InlineData("famas", WeaponClass.Rifle)]
    [InlineData("galilar", WeaponClass.Rifle)]
    [InlineData("sg556", WeaponClass.Rifle)]
    [InlineData("aug", WeaponClass.Rifle)]
    [InlineData("awp", WeaponClass.Sniper)]
    [InlineData("ssg08", WeaponClass.Sniper)]
    [InlineData("g3sg1", WeaponClass.Sniper)]
    [InlineData("scar20", WeaponClass.Sniper)]
    [InlineData("mac10", WeaponClass.Smg)]
    [InlineData("mp9", WeaponClass.Smg)]
    [InlineData("mp7", WeaponClass.Smg)]
    [InlineData("mp5sd", WeaponClass.Smg)]
    [InlineData("ump45", WeaponClass.Smg)]
    [InlineData("p90", WeaponClass.Smg)]
    [InlineData("bizon", WeaponClass.Smg)]
    [InlineData("glock", WeaponClass.Pistol)]
    [InlineData("hkp2000", WeaponClass.Pistol)]
    [InlineData("usp_silencer", WeaponClass.Pistol)]
    [InlineData("p250", WeaponClass.Pistol)]
    [InlineData("elite", WeaponClass.Pistol)]
    [InlineData("fiveseven", WeaponClass.Pistol)]
    [InlineData("tec9", WeaponClass.Pistol)]
    [InlineData("cz75a", WeaponClass.Pistol)]
    [InlineData("deagle", WeaponClass.Pistol)]
    [InlineData("revolver", WeaponClass.Pistol)]
    [InlineData("nova", WeaponClass.Shotgun)]
    [InlineData("xm1014", WeaponClass.Shotgun)]
    [InlineData("sawedoff", WeaponClass.Shotgun)]
    [InlineData("mag7", WeaponClass.Shotgun)]
    [InlineData("m249", WeaponClass.Heavy)]
    [InlineData("negev", WeaponClass.Heavy)]
    public void Classes(string name, WeaponClass expected) => Assert.Equal((int)expected, WeaponNames.ClassOf(name));

    [Theory]
    [InlineData("taser")]
    [InlineData("knife")]
    [InlineData("hegrenade")]
    [InlineData("weapon_ak47")] // callers strip the prefix first
    [InlineData("")]
    public void NoClass(string name) => Assert.Equal(Nil.V, WeaponNames.ClassOf(name));

    [Fact]
    public void EveryGunFiredInTheFixtureHasAClass()
    {
        // weapon_fire names seen in fixtures/events_two_matches.jsonl.
        string[] fired = { "ak47", "aug", "awp", "bizon", "cz75a", "deagle", "elite", "famas", "fiveseven", "galilar", "glock",
            "hkp2000", "m4a1", "m4a1_silencer", "mac10", "mp7", "mp9", "negev", "p250", "p90", "sawedoff", "sg556", "ssg08",
            "tec9", "ump45", "usp_silencer", "xm1014" };
        Assert.All(fired, n => Assert.NotEqual(Nil.V, WeaponNames.ClassOf(n)));
    }
}

public class ShotFlagRecorderTests
{
    private readonly ListSink _sink = new();
    private readonly FrameSet _frames = new();
    private readonly Recorder _r;
    private readonly int _ak;
    private const int H = 0, B1 = 1, B2 = 2;

    public ShotFlagRecorderTests()
    {
        _r = new Recorder(_sink, _frames, new PerfCounter(), _ => { });
        _r.StartCapture(new MatchMeta { Id = "11111111111111111111111111111111", Map = "de_dust2", StartUtc = "2026-10-24T17:00:00Z" });
        _r.PlayerIndex("h", "h", false); _r.PlayerIndex("b1", "b1", true); _r.PlayerIndex("b2", "b2", true);
        _r.SetHuman(H);
        _r.BeginRound(0, 1000, 0, 0, false, Nil.V);
        _r.SetFreezePlayer(H, 3, 0, 0, 100, true);
        _r.SetFreezePlayer(B1, 2, 0, 0, 100, true);
        _r.SetFreezePlayer(B2, 2, 0, 0, 100, true);
        _r.FreezeEnd(2000);
        // Human eye at (0,0,64) facing +Y; B1 straight ahead at 1000 units, not spotted.
        _frames.ByPi[H] = new PlayerFrame { Present = true, Alive = true, Team = 3, ViewZ = 64, Yaw = 90 };
        _frames.ByPi[B1] = new PlayerFrame { Present = true, Alive = true, Team = 2, Y = 1000, ViewZ = 64 };
        _frames.ByPi[B2] = new PlayerFrame { Present = true, Alive = true, Team = 2, X = -1000, ViewZ = 64 };
        _frames.Active[0] = H; _frames.Active[1] = B1; _frames.Active[2] = B2; _frames.ActiveCount = 3;
        _frames.HumanSlot = 3;
        _ak = _r.Weapons.Get("ak47");
    }

    private void Shoot(int tick) => _r.Shot(new ShotInput { Tick = tick, Weapon = _ak, Class = (int)WeaponClass.Rifle });

    private ShotRow[] Shots()
    {
        _r.Flush();
        return _sink.Store.Shots.Span.ToArray();
    }

    /// <summary>
    /// Fails if a shot's pitch/yaw are not the human's own view at the fire tick: a moving target
    /// changes aimErr but must not change them (the leak that kept sprays from comparing with pros).
    /// </summary>
    [Fact]
    public void ShotsRecordTheHumansViewNotTheTargetOffset()
    {
        _frames.ByPi[H].Pitch = 3.5f;
        _frames.ByPi[H].Yaw = 91.25f;
        Shoot(2100);
        _frames.ByPi[B1].X = 40; // the target moves; the view does not
        Shoot(2106);
        _frames.ByPi[H].Pitch = 2.75f; // recoil control pulls the view down
        Shoot(2112);
        _frames.ByPi[H].Present = false;
        Shoot(2118);
        var s = Shots();
        Assert.NotEqual(s[0].AimErrYaw, s[1].AimErrYaw);
        Assert.Equal(new[] { (3.5f, 91.25f), (3.5f, 91.25f), (2.75f, 91.25f) }, s.Take(3).Select(x => (x.Pitch, x.Yaw)));
        Assert.True(float.IsNaN(s[3].Pitch) && float.IsNaN(s[3].Yaw));
    }

    /// <summary>Fails if the file rescales the angles (they are degrees, unlike the ×100 columns), drops them on resume, or writes a missing view as a number.</summary>
    [Fact]
    public void ShotAnglesAreWrittenInDegreesAndReadBack()
    {
        _frames.ByPi[H].Pitch = -12.3456f;
        _frames.ByPi[H].Yaw = -179.5f;
        Shoot(2100);
        _frames.ByPi[H].Present = false;
        Shoot(2106);
        Shots();
        using var ms = new MemoryStream();
        MatchCodec.Write(_sink.Store, ms, inProgress: true);
        using var doc = System.Text.Json.JsonDocument.Parse(ms.ToArray());
        var shots = doc.RootElement.GetProperty("aim").GetProperty("shots");
        Assert.Equal("[-12.346,null]", shots.GetProperty("pitch").GetRawText());
        Assert.Equal("[-179.5,null]", shots.GetProperty("yaw").GetRawText());
        ms.Position = 0;
        var back = new MatchStore();
        MatchCodec.Read(ms, back);
        Assert.Equal((-12.346f, -179.5f), (back.Shots[0].Pitch, back.Shots[0].Yaw));
        Assert.True(float.IsNaN(back.Shots[1].Pitch));
    }

    [Fact]
    public void TargetIsKeptWhenNotVisibleAndVisTargetSaysSo()
    {
        Shoot(2100);
        _frames.ByPi[B1].Spot0 = 1u << 3;
        Shoot(2200);
        _frames.ByPi[B1].X = 500; // 26.6 degrees off: no target
        Shoot(2300);
        var s = Shots();
        Assert.Equal((B1, 0), (s[0].Target, s[0].VisTarget));
        Assert.Equal((B1, 1), (s[1].Target, s[1].VisTarget));
        Assert.Equal((Nil.V, Nil.V), (s[2].Target, s[2].VisTarget));
        Assert.All(s, x => Assert.Equal((int)WeaponClass.Rifle, x.Class));
    }

    [Fact]
    public void SmokeBetweenShooterAndTargetUntilExpiredOrTimedOut()
    {
        _r.Grenade(2050, B2, GrenadeType.Smoke, 0, 500, 64, entityId: 77);
        _r.Grenade(2050, B2, GrenadeType.Smoke, 0, 1500, 64, entityId: 78); // behind the target
        Shoot(2100);
        _r.SmokeExpired(2150, 77);
        Shoot(2200);
        _r.Grenade(2300, B2, GrenadeType.Smoke, 0, 500, 64, entityId: 79);
        Shoot(2300 + 22 * 64 - 1);
        Shoot(2300 + 22 * 64); // 22 s cap without an expired event
        var s = Shots();
        Assert.Equal(new[] { 1, 0, 1, 0 }, s.Select(x => x.Smoke));
    }

    [Fact]
    public void SmokeRayUsesMaxRangeWithoutTarget()
    {
        _frames.ByPi[B1].Alive = false;
        _r.Grenade(2050, B2, GrenadeType.Smoke, 0, 3000, 64, entityId: 5);
        Shoot(2100);
        Assert.Equal(1, Shots()[0].Smoke);
    }

    [Fact]
    public void ImpactsCountEveryImpactInTheShotTick()
    {
        Shoot(2100);
        _r.Impact(2100, 0, 500, 64);
        _r.Impact(2100, 0, 600, 64);
        _r.Impact(2100, 0, 700, 64);
        _r.Impact(2101, 0, 800, 64); // a later tick belongs to no shot
        Shoot(2200);
        var s = Shots();
        Assert.Equal(new[] { 3, 0 }, s.Select(x => x.Impacts));
        Assert.Equal(0, s[0].ImpYaw);
    }

    [Fact]
    public void PenetrationFromKillsUnknownForNonFatalHits()
    {
        Shoot(2100); // miss
        Shoot(2200);
        _r.Hurt(2200, H, B1, 40, 0, 60, _ak, 2, true, Nil.V); // non-fatal: unknown
        Shoot(2300);
        _r.Hurt(2300, H, B1, 60, 0, 0, _ak, 1, true, Nil.V);
        _r.Kill(new KillInput { Tick = 2300, Killer = H, Victim = B1, Assister = Nil.V, Weapon = _ak, Flags = Recorder.KillFlagWallbang, Bullet = true, NadeType = Nil.V });
        Shoot(2400);
        _r.Hurt(2400, H, B2, 100, 0, 0, _ak, 1, true, Nil.V);
        _r.Kill(new KillInput { Tick = 2400, Killer = H, Victim = B2, Assister = Nil.V, Weapon = _ak, Flags = 0, Bullet = true, NadeType = Nil.V });
        var s = Shots();
        Assert.Equal(new[] { 0, Nil.V, 1, 0 }, s.Select(x => x.Pen));
    }

    [Fact]
    public void CodecRoundTripsTheNewColumns()
    {
        _r.Grenade(2050, B2, GrenadeType.Smoke, 0, 500, 64, entityId: 77);
        Shoot(2100);
        _r.Impact(2100, 0, 500, 64);
        _r.Hurt(2100, H, B1, 40, 0, 60, _ak, 2, true, Nil.V);
        _r.Shot(new ShotInput { Tick = 2200, Weapon = _r.Weapons.Get("taser"), Class = Nil.V });
        _r.Flush();
        using var ms = new MemoryStream();
        MatchCodec.Write(_sink.Store, ms, inProgress: true);
        var back = new MatchStore();
        MatchCodec.Read(new MemoryStream(ms.ToArray()), back);
        var a = _sink.Store.Shots.Span.ToArray();
        var b = back.Shots.Span.ToArray();
        Assert.Equal(a, b);
        string json = System.Text.Encoding.UTF8.GetString(ms.ToArray());
        Assert.Contains("\"cls\":[\"rifle\",null]", json);
        Assert.Contains("\"pen\":[null,0]", json);
        Assert.Contains("\"smoke\":[1,1]", json); // the smoke is still up for the second shot
        Assert.Contains("\"visTarget\":[0,0]", json);
    }
}
