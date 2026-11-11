// Illustrative corridor-mapping job: ~30 km roughly along the A96 axis from
// Gilching (Quantum Systems' home airfield area) west to Landsberg am Lech.
// Waypoints are hand-placed approximations, not surveyed infrastructure.
export const CORRIDOR = {
  name: 'A96 corridor survey, Gilching to Landsberg am Lech (illustrative)',
  waypoints: [
    [48.0950, 11.3000], // Gilching south
    [48.0830, 11.2500], // Wessling north
    [48.0730, 11.2050], // Woerthsee
    [48.0720, 11.1500], // Inning am Ammersee
    [48.0650, 11.0850], // Greifenberg
    [48.0650, 11.0300], // Schondorf north
    [48.0700, 10.9800], // Windach
    [48.0500, 10.9000], // Landsberg am Lech east
  ],
};
// Trinity Pro published figures (datasheet QS_INT_Trinity_Pro_Techsheet_241009):
// wingspan 2.394 m, optimal cruise 17 m/s, 90 min flight time (59 min by default
// under export regulation), command-and-control range 5-7.5 km.
export const TRINITY_PRO = { wingspan: 2.394, cruise: 17, enduranceMin: 59, c2RangeKm: 7.5, maxSpeed: 35 };
