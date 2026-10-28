using System.Text;
using BotMatchStats.Core;

namespace BotMatchStats.Tests;

public class WeaponNameTests
{
    [Theory]
    [InlineData("weapon_ak47", "ak47")]
    [InlineData("ak47", "ak47")]
    [InlineData("weapon_m4a1_silencer", "m4a1_silencer")]
    [InlineData("", "")]
    public void Strip(string input, string expected) => Assert.Equal(expected, WeaponNames.Strip(input));

    [Theory]
    [InlineData("m4a1", 60, "m4a1_silencer")]
    [InlineData("m4a1", 16, null)]
    [InlineData("hkp2000", 61, "usp_silencer")]
    [InlineData("hkp2000", 32, null)]
    [InlineData("deagle", 64, "revolver")]
    [InlineData("mp7", 23, "mp5sd")]
    [InlineData("ak47", 60, null)]
    public void HurtVariant(string hurt, int defIndex, string? expected) => Assert.Equal(expected, WeaponNames.HurtVariant(hurt, defIndex));

    [Theory]
    [InlineData("ak47", true)]
    [InlineData("taser", true)]
    [InlineData("knife", false)]
    [InlineData("knife_skeleton", false)]
    [InlineData("bayonet", false)]
    [InlineData("hegrenade", false)]
    [InlineData("incgrenade", false)]
    [InlineData("inferno", false)]
    [InlineData("planted_c4", false)]
    [InlineData("c4", false)]
    [InlineData("", false)]
    public void IsBullet(string name, bool expected) => Assert.Equal(expected, WeaponNames.IsBulletWeapon(name));

    [Theory]
    [InlineData("weapon_hegrenade", UtilType.He)]
    [InlineData("flashbang", UtilType.Flash)]
    [InlineData("weapon_smokegrenade", UtilType.Smoke)]
    [InlineData("weapon_molotov", UtilType.Molotov)]
    [InlineData("weapon_incgrenade", UtilType.Incendiary)]
    [InlineData("decoy", UtilType.Decoy)]
    public void UtilTypes(string name, UtilType expected)
    {
        Assert.True(WeaponNames.TryUtilType(name, out var t));
        Assert.Equal(expected, t);
    }

    [Theory]
    [InlineData("weapon_ak47")]
    [InlineData("item_kevlar")]
    [InlineData("weapon_taser")]
    public void NonGrenadesAreNotUtility(string name) => Assert.False(WeaponNames.TryUtilType(name, out _));

    [Fact]
    public void DetonationOfIncendiaryIsMolotovFire()
    {
        Assert.Equal(GrenadeType.Molotov, WeaponNames.DetonationOf(UtilType.Incendiary));
        Assert.Equal(GrenadeType.Molotov, WeaponNames.DetonationOf(UtilType.Molotov));
        Assert.Equal(GrenadeType.Flash, WeaponNames.DetonationOf(UtilType.Flash));
    }

    [Theory]
    [InlineData("hegrenade", (int)GrenadeType.He)]
    [InlineData("inferno", (int)GrenadeType.Molotov)]
    [InlineData("molotov", (int)GrenadeType.Molotov)]
    [InlineData("ak47", Nil.V)]
    [InlineData("flashbang", Nil.V)]
    public void NadeSource(string name, int expected) => Assert.Equal(expected, WeaponNames.NadeSourceOf(name));
}

[Collection(AllocMeter.Collection)]
public class PlaceTests
{
    private static readonly (string place, int area)[] Dust2 =
    {
        ("ARamp", 0), ("BombsiteA", 0), ("Catwalk", 0), ("ExtendedA", 0), ("LongA", 0), ("LongDoors", 0), ("Pit", 0), ("ShortStairs", 0), ("UnderA", 0),
        ("BDoors", 1), ("BombsiteB", 1), ("LowerTunnel", 1), ("TunnelStairs", 1), ("UpperTunnel", 1),
        ("Hole", 2), ("MidDoors", 2), ("Middle", 2), ("TopMid", 2),
        ("CTSpawn", 3), ("Side", 3),
    };

    [Fact]
    public void Dust2TableHasExactlyTheTwentyPlaces()
    {
        var t = MapAreas.For("de_dust2")!;
        Assert.Equal(20, t.Count);
        foreach (var (place, area) in Dust2) Assert.Equal(area, t[place]);
    }

    [Fact]
    public void OtherMapsHaveNoTable() => Assert.Null(MapAreas.For("de_mirage"));

    private static byte[] Raw(string s)
    {
        var b = new byte[18];
        Encoding.UTF8.GetBytes(s).CopyTo(b, 0);
        b[^1] = 0x7A; // garbage after the terminator must be ignored
        return b;
    }

    [Fact]
    public void LookupByRawBytesAndAreas()
    {
        var t = new PlaceTable(128);
        t.SetMap("de_dust2");
        int a = t.Lookup(Raw("BombsiteA"));
        int s = t.Lookup(Raw("Side"));
        int o = t.Lookup(Raw("TSpawn"));
        Assert.Equal(0, a); Assert.Equal(1, s); Assert.Equal(2, o);
        Assert.Equal(a, t.Lookup(Raw("BombsiteA")));
        Assert.Equal(CtSetupCounter.A, t.Area(a));
        Assert.Equal(CtSetupCounter.Ct, t.Area(s));
        Assert.Equal(CtSetupCounter.Other, t.Area(o));
        Assert.Equal(Nil.V, t.Lookup(new byte[18]));
        Assert.Equal(new[] { "BombsiteA", "Side", "TSpawn" }, t.ToArray());
    }

    [Fact]
    public void RepeatedLookupDoesNotAllocate()
    {
        var t = new PlaceTable(128);
        t.SetMap("de_dust2");
        var raw = Raw("LongDoors");
        t.Lookup(raw);
        var meter = AllocMeter.Start(exact: true);
        for (int i = 0; i < 1000; i++) t.Lookup(raw);
        AllocMeter.AssertNone(meter.Read());
    }

    [Fact]
    public void PlacesWithoutAreaTableAreOther()
    {
        var t = new PlaceTable(8);
        t.SetMap("de_inferno");
        Assert.False(t.HasAreas);
        Assert.Equal(CtSetupCounter.Other, t.Area(t.Get("BombsiteA")));
    }

    [Fact]
    public void CtSetupCountsByArea()
    {
        Span<int> c = stackalloc int[CtSetupCounter.Areas];
        CtSetupCounter.Add(c, CtSetupCounter.A);
        CtSetupCounter.Add(c, CtSetupCounter.A);
        CtSetupCounter.Add(c, CtSetupCounter.Mid);
        CtSetupCounter.Add(c, CtSetupCounter.Ct);
        CtSetupCounter.Add(c, 99);
        Assert.Equal(new[] { 2, 0, 1, 1, 1 }, c.ToArray());
    }
}
