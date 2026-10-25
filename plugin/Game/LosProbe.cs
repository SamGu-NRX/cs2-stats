using BotMatchStats.Core;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Utils;

namespace BotMatchStats.Game;

/// <summary>
/// Line of sight through CounterStrikeSharp's own trace, <see cref="Trace.TraceEndShape"/> (1.0.378,
/// natives_raytrace in the core). Chosen over signature-based natives because CounterStrikeSharp ships
/// and maintains it with the core and its gamedata; on this machine BotAimImprover, BotState and
/// NadeSystem already call it every round on CS2 1.41.9.2. Any exception, or a result that is not a
/// number, makes <see cref="Clear"/> return null, which turns line of sight off for the map; the
/// recorder then falls back to the spotted mask and the file says so (env.losError).
///
/// Allocation: the two endpoint vectors and the options are created once, on the game thread after a
/// map has loaded (vectors are native memory); the ignored entity's wrapper is re-created only when
/// the human's pawn changes. <see cref="Trace.TraceEndShape"/> returns its result by value.
/// </summary>
internal sealed class TraceLosProbe : ILosProbe
{
    /// <summary>
    /// World geometry that blocks bullets and sight, without players or NPCs: the same mask
    /// BotState uses for its flash line of sight on this build.
    /// </summary>
    public static readonly Contents Mask = Masks.SolidBrushOnly;
    /// <summary>A trace this close to its end point counts as clear.</summary>
    public const float ClearFraction = 0.999f;

    private readonly Vector _a = new(0, 0, 0), _b = new(0, 0, 0);
    private readonly TraceOptions _opts = new() { InteractsWith = Mask };
    private CBaseEntity? _ignore;
    private nint _ignorePtr;

    public string? Error { get; private set; }

    /// <summary>The human's pawn, so the trace never stops on it.</summary>
    public void SetIgnore(nint pawn)
    {
        if (pawn == _ignorePtr) return;
        _ignorePtr = pawn;
        _ignore = pawn == 0 ? null : new CBaseEntity(pawn);
    }

    public bool? Clear(double ax, double ay, double az, double bx, double by, double bz)
    {
        if (Error != null) return null;
        try
        {
            _a.X = (float)ax; _a.Y = (float)ay; _a.Z = (float)az;
            _b.X = (float)bx; _b.Y = (float)by; _b.Z = (float)bz;
            var r = Trace.TraceEndShape(_a, _b, _ignore!, _opts);
            float f = r.Fraction;
            if (!float.IsFinite(f)) { Error = $"trace fraction {f}"; return null; }
            return f >= ClearFraction;
        }
        catch (Exception ex)
        {
            Error = $"{ex.GetType().Name}: {ex.Message}";
            return null;
        }
    }
}
