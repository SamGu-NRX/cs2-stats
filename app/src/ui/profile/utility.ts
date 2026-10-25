// The profile's Utility group lists HLTV's five sub-stats first; these follow under "More":
// HLTV's match-page utility stats, then the fuller Leetify-style list.
export const UTILITY_HLTV_EXTRA = ["u_grenadeDmgPR", "u_oppFlashed", "u_flashAssists"];
export const UTILITY_MORE = [
  ...UTILITY_HLTV_EXTRA,
  "u_enemiesPerFlash", "u_blindPerFlash", "u_blindPerEnemy", "u_effectivePct", "u_flashKills", "u_teamFlashed", "u_teamBlind",
  "u_teamBlindAvg", "u_selfFlashed", "u_hesPR", "u_dmgPerHE", "u_enemiesPerHE", "u_heTeamDmg", "u_molotovsPR", "u_dmgPerMolotov",
  "u_burnTime", "u_smokesPR", "u_thrownPR", "u_spentPR", "u_unusedPR",
];
