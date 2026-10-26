// Callout names as the game shows them. Match files carry the map's navigation-mesh place names
// ("TopofMid", "BombsiteB"); the player knows them as "Top of Mid" and "B Site". One table keyed by the
// raw name; a name that already reads right ("Catwalk", "Pit") or that the table does not hold passes
// through unchanged, so a new map's places still show.
const CALLOUT: Record<string, string> = {
  BombsiteA: "A Site",
  BombsiteB: "B Site",
  BombsiteC: "C Site",
  TSpawn: "T Spawn",
  CTSpawn: "CT Spawn",
  TRamp: "T Ramp",
  ARamp: "A Ramp",
  BRamp: "B Ramp",
  TopofMid: "Top of Mid",
  Middle: "Mid",
  MidDoors: "Mid Doors",
  BDoors: "B Doors",
  LongDoors: "Long Doors",
  LongA: "A Long",
  OutsideLong: "Outside Long",
  ExtendedA: "Extended A",
  UnderA: "Under A",
  ShortStairs: "Short Stairs",
  UpperTunnel: "Upper Tunnels",
  LowerTunnel: "Lower Tunnels",
  OutsideTunnel: "Outside Tunnels",
  TunnelStairs: "Tunnel Stairs",
  BackofA: "Back of A",
  BackofB: "Back of B",
};

/** The callout as the game shows it; unknown names unchanged. */
export const calloutName = (place: string): string => CALLOUT[place] ?? place;
