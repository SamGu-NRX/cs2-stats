using BotMatchStats.Core;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Memory;

namespace BotMatchStats.Game;

/// <summary>
/// Allocation-free reads of entity memory for the per-tick path. CSSharp's schema properties
/// allocate a lookup key and a wrapper object on every access, so the hot path reads fields at
/// offsets resolved once at load. Entity lookups mirror CSSharp's own EntitySystem (chunked
/// identity list, handle check) so a freed or reused entity is never read.
/// </summary>
internal static unsafe class Mem
{
    // Same constants as CounterStrikeSharp.API.Modules.Entities.EntitySystem (v1.0.378).
    private const int EntitiesPerChunk = 512;
    private const int IdentitySize = 0x70;
    private const int IdentityHandleOffset = 0x10;
    private const int MaxChunks = 32768 / EntitiesPerChunk;
    private const uint IndexMask = 0x7FFF;
    public const uint InvalidHandle = 0xFFFFFFFF;

    private static nint _list;

    public static int CtrlPawn, Team, LifeState, Health, BodyComponent, SceneNode, AbsOrigin, ViewZ,
        EyeAngles, SpottedMask, Place, AbsVelocity, Scoped, MovementServices, Ducked, WeaponServices,
        MyWeapons, ActiveWeapon, Ammo, EquipCurrent, PawnController, OwnerEntity, EntityIdentity, DesignerName,
        OriginalControllerOfPawn, Armor, ItemServices, HasHelmet, HasDefuser, SpottedFlag, ItemDefIndex;

    public const int PlaceBytes = 18;

    /// <summary>Resolves offsets. Returns a description of the first problem, or null when all are usable.</summary>
    public static string? Init()
    {
        _list = NativeAPI.GetConcreteEntityListPointer();
        if (_list == 0) return "entity list pointer is null";
        string? bad = null;
        int O(string cls, string field)
        {
            int o = Schema.GetSchemaOffset(cls, field);
            if (o <= 0 && bad == null) bad = $"schema offset {cls}::{field} = {o}";
            return o;
        }
        CtrlPawn = O("CCSPlayerController", "m_hPlayerPawn");
        Team = O("CBaseEntity", "m_iTeamNum");
        LifeState = O("CBaseEntity", "m_lifeState");
        Health = O("CBaseEntity", "m_iHealth");
        BodyComponent = O("CBaseEntity", "m_CBodyComponent");
        SceneNode = O("CBodyComponent", "m_pSceneNode");
        AbsOrigin = O("CGameSceneNode", "m_vecAbsOrigin");
        ViewZ = O("CBaseModelEntity", "m_vecViewOffset") + O("CNetworkViewOffsetVector", "m_vecZ");
        EyeAngles = O("CCSPlayerPawn", "m_angEyeAngles");
        SpottedMask = O("CCSPlayerPawn", "m_entitySpottedState") + O("EntitySpottedState_t", "m_bSpottedByMask");
        SpottedFlag = O("CCSPlayerPawn", "m_entitySpottedState") + O("EntitySpottedState_t", "m_bSpotted");
        Place = O("CCSPlayerPawn", "m_szLastPlaceName");
        AbsVelocity = O("CBaseEntity", "m_vecAbsVelocity");
        Scoped = O("CCSPlayerPawn", "m_bIsScoped");
        MovementServices = O("CBasePlayerPawn", "m_pMovementServices");
        Ducked = O("CCSPlayer_MovementServices", "m_bDucked");
        WeaponServices = O("CBasePlayerPawn", "m_pWeaponServices");
        MyWeapons = O("CPlayer_WeaponServices", "m_hMyWeapons");
        ActiveWeapon = O("CPlayer_WeaponServices", "m_hActiveWeapon");
        Ammo = O("CPlayer_WeaponServices", "m_iAmmo");
        EquipCurrent = O("CCSPlayerPawn", "m_unCurrentEquipmentValue");
        PawnController = O("CBasePlayerPawn", "m_hController");
        OwnerEntity = O("CBaseEntity", "m_hOwnerEntity");
        EntityIdentity = O("CEntityInstance", "m_pEntity");
        DesignerName = O("CEntityIdentity", "m_designerName");
        OriginalControllerOfPawn = O("CCSPlayerController", "m_hOriginalControllerOfCurrentPawn");
        Armor = O("CCSPlayerPawn", "m_ArmorValue");
        ItemServices = O("CBasePlayerPawn", "m_pItemServices");
        HasHelmet = O("CCSPlayer_ItemServices", "m_bHasHelmet");
        HasDefuser = O("CCSPlayer_ItemServices", "m_bHasDefuser");
        // Optional: without it the hurt handler cannot tell weapon variants apart (as when the old wrapper chain returned -1).
        int am = Schema.GetSchemaOffset("CEconEntity", "m_AttributeManager"), it = Schema.GetSchemaOffset("CAttributeContainer", "m_Item"),
            di = Schema.GetSchemaOffset("CEconItemView", "m_iItemDefinitionIndex");
        ItemDefIndex = am > 0 && it > 0 && di > 0 ? am + it + di : -1;
        return bad;
    }

    public static nint ByIndex(int index, out uint handle)
    {
        handle = InvalidHandle;
        if ((uint)index >= 32767) return 0;
        nint chunk = ((nint*)_list)[index / EntitiesPerChunk];
        if (chunk == 0) return 0;
        nint ident = chunk + IdentitySize * (index % EntitiesPerChunk);
        uint h = *(uint*)(ident + IdentityHandleOffset);
        if ((h & IndexMask) != (uint)index) return 0;
        handle = h;
        return *(nint*)ident;
    }

    public static nint ByHandle(uint raw)
    {
        if (raw == InvalidHandle) return 0;
        int index = (int)(raw & IndexMask);
        if (index / EntitiesPerChunk >= MaxChunks) return 0;
        nint chunk = ((nint*)_list)[index / EntitiesPerChunk];
        if (chunk == 0) return 0;
        nint ident = chunk + IdentitySize * (index % EntitiesPerChunk);
        if (*(uint*)(ident + IdentityHandleOffset) != raw) return 0;
        return *(nint*)ident;
    }

    public static T Read<T>(nint p, int off) where T : unmanaged => *(T*)(p + off);

    public static nint Ptr(nint p, int off) => p == 0 ? 0 : *(nint*)(p + off);

    /// <summary>The pawn of a controller, or 0. The controller must already be validated.</summary>
    public static nint PawnOf(nint ctrl) => ByHandle(*(uint*)(ctrl + CtrlPawn));

    public static void Origin(nint pawn, out float x, out float y, out float z)
    {
        nint node = Ptr(Ptr(pawn, BodyComponent), SceneNode);
        if (node == 0) { x = y = z = float.NaN; return; }
        float* v = (float*)(node + AbsOrigin);
        x = v[0]; y = v[1]; z = v[2];
    }

    public static bool Alive(nint pawn) => *(byte*)(pawn + LifeState) == 0 && *(int*)(pawn + Health) > 0;

    /// <summary>Fills a frame from a pawn. Place is resolved only when <paramref name="place"/> is non-null.</summary>
    public static void Frame(nint pawn, int team, ref PlayerFrame f, PlaceTable? place)
    {
        f.Present = true;
        f.Team = team;
        f.Alive = Alive(pawn);
        Origin(pawn, out f.X, out f.Y, out f.Z);
        f.ViewZ = *(float*)(pawn + ViewZ);
        float* ang = (float*)(pawn + EyeAngles);
        f.Pitch = ang[0];
        f.Yaw = ang[1];
        uint* mask = (uint*)(pawn + SpottedMask);
        f.Spot0 = mask[0];
        f.Spot1 = mask[1];
        if (place != null) f.Place = place.Lookup(new ReadOnlySpan<byte>((void*)(pawn + Place), PlaceBytes));
        if (float.IsNaN(f.X)) f.Present = false;
    }

    public static int HorizontalSpeed(nint pawn)
    {
        float* v = (float*)(pawn + AbsVelocity);
        return (int)MathF.Round(MathF.Sqrt(v[0] * v[0] + v[1] * v[1]));
    }

    public static void SpottedState(nint pawn, out uint m0, out uint m1, out bool spotted)
    {
        uint* mask = (uint*)(pawn + SpottedMask);
        m0 = mask[0];
        m1 = mask[1];
        spotted = *(byte*)(pawn + SpottedFlag) != 0;
    }

    /// <summary>Entity index of an entity, from its identity's handle.</summary>
    public static int IndexOf(nint entity)
    {
        nint ident = Ptr(entity, EntityIdentity);
        return ident == 0 ? -1 : (int)(*(uint*)(ident + 0x10) & IndexMask);
    }

    public static bool IsScoped(nint pawn) => *(byte*)(pawn + Scoped) != 0;

    public static bool IsDucked(nint pawn)
    {
        nint ms = Ptr(pawn, MovementServices);
        return ms != 0 && *(byte*)(ms + Ducked) != 0;
    }

    public static int EquipValue(nint pawn) => *(ushort*)(pawn + EquipCurrent);

    public static uint ActiveWeaponHandle(nint pawn)
    {
        nint ws = Ptr(pawn, WeaponServices);
        return ws == 0 ? InvalidHandle : *(uint*)(ws + ActiveWeapon);
    }

    /// <summary>Item definition index of the pawn's active weapon, or -1. Replaces a chain of CSSharp wrappers in the hurt handler.</summary>
    public static int ActiveItemDef(nint pawn)
    {
        if (ItemDefIndex <= 0) return -1;
        nint w = ByHandle(ActiveWeaponHandle(pawn));
        return w == 0 ? -1 : *(ushort*)(w + ItemDefIndex);
    }

    /// <summary>The player slot of an entity's owner pawn's controller (grenade projectiles, infernos), or -1.</summary>
    public static int OwnerSlot(nint entity)
    {
        nint pawn = ByHandle(*(uint*)(entity + OwnerEntity));
        if (pawn == 0) return -1;
        uint ctrl = *(uint*)(pawn + PawnController);
        if (ctrl == InvalidHandle || ByHandle(ctrl) == 0) return -1;
        return (int)(ctrl & IndexMask) - 1;
    }

    private static ReadOnlySpan<byte> PrefixWeapon => "weapon_"u8;

    /// <summary>Fills <paramref name="dest"/> with the pawn's weapon entities; returns the count, or -1 if unreadable.</summary>
    public static int Weapons(nint pawn, Span<nint> dest)
    {
        nint ws = Ptr(pawn, WeaponServices);
        if (ws == 0) return -1;
        int count = *(int*)(ws + MyWeapons);
        nint elems = *(nint*)(ws + MyWeapons + 8);
        if (count < 0 || count > dest.Length || elems == 0) return -1;
        int n = 0;
        for (int i = 0; i < count; i++)
        {
            nint w = ByHandle(((uint*)elems)[i]);
            if (w != 0) dest[n++] = w;
        }
        return n;
    }

    /// <summary>FNV-1a hash of an entity's designer name, without creating a string; 0 if unreadable.</summary>
    public static ulong DesignerNameHash(nint entity)
    {
        nint name = Ptr(Ptr(entity, EntityIdentity), DesignerName);
        if (name == 0) return 0;
        byte* s = (byte*)name;
        ulong h = 14695981039346656037UL;
        for (int i = 0; i < 64 && s[i] != 0; i++) { h ^= s[i]; h *= 1099511628211UL; }
        return h;
    }

    /// <summary>Grenades of one type held: the ammo count at the type's ammo slot, at least 1.</summary>
    public static int GrenadeCount(nint pawn, int ammoSlot)
    {
        nint ws = Ptr(pawn, WeaponServices);
        if (ws == 0 || ammoSlot < 0) return 1;
        return Math.Max(1, (int)*(ushort*)(ws + Ammo + 2 * ammoSlot));
    }

    public static int ArmorValue(nint pawn) => *(int*)(pawn + Armor);

    public static bool HasHelmetItem(nint pawn)
    {
        nint s = Ptr(pawn, ItemServices);
        return s != 0 && *(byte*)(s + HasHelmet) != 0;
    }

    public static bool HasDefuserItem(nint pawn)
    {
        nint s = Ptr(pawn, ItemServices);
        return s != 0 && *(byte*)(s + HasDefuser) != 0;
    }

    /// <summary>The controller handle recorded as the original owner of the pawn this controller drives.</summary>
    public static uint OriginalControllerHandle(nint ctrl) => *(uint*)(ctrl + OriginalControllerOfPawn);

    /// <summary>Counts grenades held, by designer name; reads ammo for stacked grenades when the ammo slot is known.</summary>
    public static UtilCounts Utility(nint pawn, ReadOnlySpan<int> ammoSlotByType, out int weaponCount)
    {
        var u = new UtilCounts { Known = true };
        weaponCount = 0;
        nint ws = Ptr(pawn, WeaponServices);
        if (ws == 0) { u.Known = false; return u; }
        int count = *(int*)(ws + MyWeapons);
        nint elems = *(nint*)(ws + MyWeapons + 8);
        if (count < 0 || count > 64 || elems == 0) { u.Known = false; return u; }
        for (int i = 0; i < count; i++)
        {
            nint w = ByHandle(((uint*)elems)[i]);
            if (w == 0) continue;
            weaponCount++;
            int t = UtilTypeOf(w);
            if (t < 0) continue;
            int slot = ammoSlotByType[t];
            int n = slot >= 0 ? *(ushort*)(ws + Ammo + 2 * slot) : 1;
            u[t] += Math.Max(n, 1);
        }
        return u;
    }

    /// <summary>UtilType index of a weapon entity from its designer name, or -1.</summary>
    public static int UtilTypeOf(nint weapon)
    {
        nint ident = Ptr(weapon, EntityIdentity);
        nint name = Ptr(ident, DesignerName);
        if (name == 0) return -1;
        byte* s = (byte*)name;
        for (int i = 0; i < 7; i++) if (s[i] != PrefixWeapon[i]) return -1;
        s += 7;
        if (Eq(s, "hegrenade"u8)) return (int)UtilType.He;
        if (Eq(s, "flashbang"u8)) return (int)UtilType.Flash;
        if (Eq(s, "smokegrenade"u8)) return (int)UtilType.Smoke;
        if (Eq(s, "molotov"u8)) return (int)UtilType.Molotov;
        if (Eq(s, "incgrenade"u8)) return (int)UtilType.Incendiary;
        if (Eq(s, "decoy"u8)) return (int)UtilType.Decoy;
        return -1;
    }

    private static bool Eq(byte* s, ReadOnlySpan<byte> lit)
    {
        for (int i = 0; i < lit.Length; i++) if (s[i] != lit[i]) return false;
        return s[lit.Length] == 0;
    }
}
