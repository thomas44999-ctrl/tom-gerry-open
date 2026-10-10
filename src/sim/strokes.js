// VERTRAG zwischen Spiellogik (src/game/*) und Animation (src/chars/*).
// Beide Seiten lesen diese Tabelle. Werte dürfen beim Feintuning angepasst werden,
// aber Schlüssel und Bedeutung bleiben stabil.
//
// Koordinaten des Trefferpunkts relativ zum Spieler ("Spielerrahmen"):
//   right   = Meter zur rechten Körperseite des Spielers (negativ = links)
//   up      = Meter über dem Boden
//   forward = Meter in Blickrichtung (Blickrichtung = zum Netz/Gegner hin)
// Beide Figuren sind Rechtshänder: Vorhand rechts, Rückhand links.
// Werte gelten für Skalierung 1.0 (Mensch ~1.8 m). Pro Figur skaliert PLAYER_STATS[x].reachScale (Chibi-Figuren ~0.75–0.8).
//
// windup = Zeit vom Start der Schlaganimation bis zum Balltreffer (s)
// follow = Zeit nach dem Treffer bis die Animation endet (s)
// reach  = maximaler Abstand (m) zwischen idealem und tatsächlichem Trefferpunkt,
//          den Animation (IK/Ausfallschritt) noch glaubwürdig überbrückt.
// height = [min, max] Ballhöhe (m) am Treffpunkt, in der der Schlag möglich ist.
// preBounce = Schlag wird vor dem Aufsprung gespielt (Volley/Schmetterball).

export const STROKES = {
  forehand:        { family: 'groundstroke', side: 'fh', windup: 0.42, follow: 0.55, contact: { right: 0.78, up: 0.95, forward: 0.50 }, reach: 1.25, height: [0.25, 1.75], preBounce: false },
  backhand:        { family: 'groundstroke', side: 'bh', windup: 0.44, follow: 0.55, contact: { right: -0.72, up: 0.95, forward: 0.45 }, reach: 1.15, height: [0.25, 1.65], preBounce: false },
  forehand_slice:  { family: 'slice',        side: 'fh', windup: 0.40, follow: 0.45, contact: { right: 0.72, up: 0.85, forward: 0.55 }, reach: 1.30, height: [0.15, 1.60], preBounce: false },
  backhand_slice:  { family: 'slice',        side: 'bh', windup: 0.40, follow: 0.45, contact: { right: -0.70, up: 0.85, forward: 0.55 }, reach: 1.30, height: [0.15, 1.60], preBounce: false },
  forehand_volley: { family: 'volley',       side: 'fh', windup: 0.20, follow: 0.30, contact: { right: 0.62, up: 1.10, forward: 0.70 }, reach: 1.35, height: [0.20, 2.00], preBounce: true },
  backhand_volley: { family: 'volley',       side: 'bh', windup: 0.20, follow: 0.30, contact: { right: -0.58, up: 1.10, forward: 0.65 }, reach: 1.30, height: [0.20, 1.95], preBounce: true },
  smash:           { family: 'smash',        side: 'fh', windup: 0.50, follow: 0.50, contact: { right: 0.34, up: 2.20, forward: 0.45 }, reach: 0.90, height: [1.75, 3.00], preBounce: true },
  // Aufschlag: eigener Ablauf (siehe SERVE). contact = Treffpunkt bei perfektem Timing.
  // Aufschlag-Treffpunkt etwas niedriger als beim Profi: Chibi-Figuren springen dafür (Mario-Tennis-Stil)
  serve:           { family: 'serve',        side: 'fh', windup: 0.30, follow: 0.65, contact: { right: 0.26, up: 2.30, forward: 0.45 }, reach: 0.60, height: [1.75, 2.80], preBounce: true },
};

// Lob und Stopp verwenden die Grundschlag-/Slice-Animationen mit anderem Ausschwung.
// Die Spiellogik meldet beim Schlagstart zusätzlich `shot` ('topspin'|'slice'|'lob'|'drop'|'flat'),
// die Animation darf daran Ausschwung/Schlägerwinkel variieren.
export const SHOT_TO_STROKE = {
  topspin: { fh: 'forehand', bh: 'backhand' },
  flat:    { fh: 'forehand', bh: 'backhand' },
  lob:     { fh: 'forehand', bh: 'backhand' },
  slice:   { fh: 'forehand_slice', bh: 'backhand_slice' },
  drop:    { fh: 'forehand_slice', bh: 'backhand_slice' },
};

// Aufschlag-Ablauf (Zeiten in s). Zeitachse beginnt mit dem Druck auf die Schlagtaste (Ballwurf).
//   0 .. tossRelease         Arm hebt, Ball verlässt die Hand bei t = tossRelease (Höhe = releaseUp)
//   Ball fliegt senkrecht bis contact.up + tossApexAbove und fällt wieder.
//   Zweiter Tastendruck startet den Schwung; Treffer erfolgt windup (STROKES.serve.windup) später.
//   Optimal: Treffer, wenn der Ball wieder auf contact.up gefallen ist (kurz nach dem Scheitel).
export const SERVE = {
  tossRelease: 0.32,
  releaseUp: 1.35,
  tossApexAbove: 0.45,       // Scheitel liegt so viel über dem idealen Treffpunkt
  maxWait: 2.2,              // ohne zweiten Druck: Ball fällt, wird gefangen, neuer Versuch (kein Fehler)
  bouncesBeforeServe: 2,     // Ball-Tippen vor dem Aufschlag (nur Animation/Ton)
};

// Spieler-Werte (0..1, außer wo Einheiten angegeben). Spiellogik und KI nutzen sie.
export const PLAYER_STATS = {
  tom: {
    name: 'Tom', reachScale: 0.8, height: 1.34,
    maxSpeed: 6.1, accel: 19, decel: 24,     // m/s, m/s²
    power: 0.86, serve: 0.90, spin: 0.72, control: 0.82, touch: 0.75, volley: 0.78,
    handed: 'right',
  },
  gerry: {
    name: 'Gerry', reachScale: 0.74, height: 1.32,
    maxSpeed: 6.7, accel: 23, decel: 28,
    power: 0.74, serve: 0.76, spin: 0.88, control: 0.84, touch: 0.88, volley: 0.82,
    handed: 'right',
  },
};

/** Trefferpunkt aus Spielerrahmen in Weltkoordinaten. yaw: 0 = Blick nach +Z. */
export function strokeContactWorld(out, playerPos, yaw, contact, scale = 1) {
  // Blickrichtung f = (sin yaw, 0, cos yaw); rechte Seite r = (-cos yaw, 0, sin yaw)
  const s = Math.sin(yaw), c = Math.cos(yaw);
  const r = contact.right * scale, f = contact.forward * scale;
  out[0] = playerPos[0] + s * f - c * r;
  out[1] = contact.up * scale;
  out[2] = playerPos[2] + c * f + s * r;
  return out;
}
