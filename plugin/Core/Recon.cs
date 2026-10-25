namespace BotMatchStats.Core;

/// <summary>Per-round per-player totals the plugin derived from events.</summary>
public struct Tally
{
    public int Kills, Deaths, Assists, Damage, Hits;
}

/// <summary>The game's own per-round numbers from <c>CSPerRoundStats_t</c>.</summary>
public struct GameRoundStats
{
    public int Kills, Deaths, Assists, Damage;
}

/// <summary>
/// Rules derived from fixtures/events_two_matches.jsonl against the game's per-round stats
/// (21-round match, 300 player-rounds):
/// kills = enemy kills, deaths = every death including bomb and world, assists = damage plus
/// flash assists; these matched exactly. Damage = enemy damage capped at pre-hit HP; the game's
/// number was never lower and at most one HP per hit higher (player_hurt truncates fractional
/// damage), so the damage check accepts <c>0 &lt;= game - ours &lt;= hits</c>.
/// </summary>
public static class Recon
{
    public static bool DamageOk(int ours, int game, int hits)
    {
        int d = game - ours;
        return d >= 0 && d <= hits;
    }

    /// <summary>Returns a bit per mismatching field (1 &lt;&lt; ReconField).</summary>
    public static int Compare(in Tally ours, in GameRoundStats game)
    {
        int m = 0;
        if (ours.Kills != game.Kills) m |= 1 << (int)ReconField.Kills;
        if (ours.Deaths != game.Deaths) m |= 1 << (int)ReconField.Deaths;
        if (ours.Assists != game.Assists) m |= 1 << (int)ReconField.Assists;
        if (!DamageOk(ours.Damage, game.Damage, ours.Hits)) m |= 1 << (int)ReconField.Damage;
        return m;
    }

    public static readonly string[] FieldNames = { "k", "d", "a", "dmg" };
}
