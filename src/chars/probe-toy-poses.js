// Figuren-Probe, Variante B: Stimmungen, Schlüsselposen und Clips der Spielzeugfiguren.
// Posen: Euler-Winkel in Grad je Knoten (Drehung im Eltern-Raum, Blick +Z, links = +X).
//   Arme/Beine hängen entlang -Y: X negativ = nach vorn, Z = seitlich (links +, rechts -).
//   Rumpf/Kopf: X positiv = nach vorn neigen, Y positiv = nach links drehen. Fuß: X positiv = Spitze runter.
//   racket: Schläger relativ zur Hand (+Y = Schaft). hips: Versatz in m. sq: Squash (<1) / Stretch (>1).
//   bob: Kopf-Nicken (Feder). mood: Gesicht. tail: Krümmung je Schwanzglied, tailBase: Ansatzwinkel.
// Clips: Schlüsselposen mit Haltezeit (hold, s) und kurzem Übergang (tween, s), wie 2-5-Frame-Pixelanimation.

export const MOODS = {
  neutral: { mouth: 'smile', brow: 0 },
  focused: { mouth: 'grit', brow: 20, browLift: -0.008 },
  effort: { mouth: 'oh', brow: -16, browLift: 0.012 },
  shout: { mouth: 'open', brow: 22, browLift: -0.006 },
  grin: { mouth: 'grin', brow: -6, browLift: 0.006 },
  happy: { mouth: 'open', happyEyes: true, brow: -12, browLift: 0.022 },
  sad: { mouth: 'frown', brow: -24, browLift: 0.004, eyeY: 0.62, eyeDrop: -0.014 },
};

const READY = {
  hips: [0, -0.035, 0],
  rot: {
    body: [12, 0, 0], head: [-8, 0, 0],
    armR: [-22, 0, -16], foreR: [-42, 0, 0], handR: [0, 0, 0], racket: [62, 0, 42],
    armL: [-20, 0, 16], foreL: [-48, 0, 0],
    legL: [-4, 0, 9], legR: [-4, 0, -9], footL: [4, 0, -9], footR: [4, 0, 9],
    tail: [16, 0, 4],
  },
  tailBase: -55, sq: 0.97, mood: 'neutral',
};

function pose(base, over) {
  return { ...base, ...over, rot: { ...base.rot, ...(over.rot || {}) } };
}

export const TOY_POSES = {
  ready: READY,
  ready2: pose(READY, { hips: [0, -0.06, 0], sq: 0.93, bob: 0.04, rot: { body: [15, 0, 0], tail: [22, 0, -6] } }),

  // Laufen (Blick in Laufrichtung): Kontakt links, Hochpunkt, Kontakt rechts, Hochpunkt
  run1: {
    hips: [0, -0.02, 0], sq: 0.94, bob: 0.05, mood: 'effort', tailBase: -80,
    rot: {
      body: [18, 8, 0], head: [-10, -6, 0],
      legL: [-48, 0, 4], footL: [-18, 0, 0], legR: [38, 0, -4], footR: [30, 0, 0],
      armL: [38, 0, 16], foreL: [-60, 0, 0], armR: [-55, 0, -14], foreR: [-70, 0, 0], racket: [70, 0, 10],
      tail: [10, 20, 0],
    },
  },
  run2: {
    hips: [0, 0.05, 0], sq: 1.07, bob: -0.05, mood: 'effort', tailBase: -70,
    rot: {
      body: [16, 0, 0], head: [-6, 0, 0],
      legL: [-12, 0, 4], footL: [10, 0, 0], legR: [-28, 0, -4], footR: [35, 0, 0],
      armL: [0, 0, 18], foreL: [-70, 0, 0], armR: [-15, 0, -16], foreR: [-75, 0, 0], racket: [80, 0, 10],
      tail: [18, 0, 0],
    },
  },
  run3: {
    hips: [0, -0.02, 0], sq: 0.94, bob: 0.05, mood: 'effort', tailBase: -80,
    rot: {
      body: [18, -8, 0], head: [-10, 6, 0],
      legR: [-48, 0, -4], footR: [-18, 0, 0], legL: [38, 0, 4], footL: [30, 0, 0],
      armR: [30, 0, -16], foreR: [-65, 0, 0], armL: [-55, 0, 14], foreL: [-70, 0, 0], racket: [80, 0, 10],
      tail: [10, -20, 0],
    },
  },
  run4: {
    hips: [0, 0.05, 0], sq: 1.07, bob: -0.05, mood: 'effort', tailBase: -70,
    rot: {
      body: [16, 0, 0], head: [-6, 0, 0],
      legR: [-12, 0, -4], footR: [10, 0, 0], legL: [-28, 0, 4], footL: [35, 0, 0],
      armR: [5, 0, -18], foreR: [-70, 0, 0], armL: [-20, 0, 16], foreL: [-70, 0, 0], racket: [80, 0, 10],
      tail: [18, 0, 0],
    },
  },
  // Stolpern: Fußspitze bleibt hängen, Oberkörper kippt, Arme rudern
  stumble: {
    hips: [0, -0.05, 0.04], sq: 0.88, bob: 0.08, mood: 'effort', tailBase: -20,
    rot: {
      body: [34, 0, 6], head: [16, 0, -8],
      legL: [-62, 0, 6], footL: [-30, 0, 0], legR: [42, 0, -6], footR: [45, 0, 0],
      armL: [-30, 0, 95], foreL: [-30, 0, 0], armR: [-60, 0, -105], foreR: [-20, 0, 0], racket: [90, 0, 0],
      tail: [-10, 0, 25],
    },
  },

  // Vorhand
  windup: {
    hips: [0, -0.06, 0], sq: 0.92, mood: 'focused', tailBase: -40,
    rot: {
      body: [10, -58, 0], head: [-4, 46, 0],
      armR: [40, 0, -95], foreR: [-30, 0, 0], racket: [145, 0, 0],
      armL: [-82, 0, 26], foreL: [-12, 0, 0],
      legL: [-14, 0, 14], legR: [14, 0, -14], footL: [0, 0, -14], footR: [0, 0, 14],
      tail: [20, 0, 15],
    },
  },
  hit: {
    hips: [0, -0.02, 0.02], sq: 1.08, bob: -0.04, mood: 'shout', tailBase: -70,
    rot: {
      body: [8, 22, 0], head: [2, -16, 0],
      armR: [-15, 0, -80], foreR: [-8, 0, 0], racket: [168, 0, 0],
      armL: [24, 0, 42], foreL: [-30, 0, 0],
      legL: [-16, 0, 14], legR: [18, 0, -14], footL: [0, 0, -14], footR: [10, 0, 14],
      tail: [14, 0, -20],
    },
  },
  follow: {
    hips: [0, -0.03, 0], sq: 0.97, mood: 'grin', tailBase: -60,
    rot: {
      body: [6, 58, 0], head: [-4, -34, 0],
      armR: [-130, 0, -40], foreR: [-40, 0, 0], racket: [150, 0, 0],
      armL: [10, 0, 30], foreL: [-60, 0, 0],
      legL: [-8, 0, 12], legR: [12, 0, -12], footL: [0, 0, -12], footR: [20, 0, 12],
      tail: [16, 0, -10],
    },
  },

  // Jubel: Hocke, Luftsprung, Landung
  crouch: {
    hips: [0, -0.1, 0], sq: 0.84, bob: 0.06, mood: 'grin', tailBase: -50,
    rot: {
      body: [24, 0, 0], head: [-14, 0, 0],
      armL: [28, 0, 24], foreL: [-40, 0, 0], armR: [28, 0, -24], foreR: [-40, 0, 0], racket: [120, 0, 0],
      legL: [-30, 0, 14], legR: [-30, 0, -14], footL: [28, 0, -14], footR: [28, 0, 14],
      tail: [24, 0, 0],
    },
  },
  jump: {
    hips: [0, 0.26, 0], sq: 1.16, bob: -0.07, mood: 'happy', tailBase: -100,
    rot: {
      body: [-6, 0, 0], head: [-12, 0, 0],
      armL: [-10, 0, 150], foreL: [-10, 0, 0], armR: [-10, 0, -152], foreR: [-12, 0, 0], racket: [180, 0, 0],
      legL: [-34, 0, 12], footL: [35, 0, 0], legR: [10, 0, -10], footR: [40, 0, 0],
      tail: [-14, 0, 0],
    },
  },
  land: {
    hips: [0, -0.06, 0], sq: 0.88, bob: 0.07, mood: 'happy', tailBase: -60,
    rot: {
      body: [8, 0, 0], head: [-10, 0, 0],
      armL: [-10, 0, 140], foreL: [-20, 0, 0], armR: [-10, 0, -140], foreR: [-20, 0, 0], racket: [180, 0, 0],
      legL: [-14, 0, 14], legR: [-14, 0, -14], footL: [14, 0, -14], footR: [14, 0, 14],
      tail: [20, 0, 0],
    },
  },

  // Enttäuscht: zusammengesackt, Schläger hängt, Fußspitzen nach innen
  slump: {
    hips: [0, -0.04, 0], sq: 0.93, mood: 'sad', tailBase: 25,
    rot: {
      body: [26, 0, 0], head: [26, 0, 6],
      armL: [6, 0, 4], foreL: [-4, 0, 0], armR: [6, 0, -4], foreR: [-4, 0, 0], racket: [118, 0, 0],
      legL: [0, 0, -3], legR: [0, 0, 3], footL: [0, -18, 0], footR: [0, 18, 0],
      tail: [6, 0, 0],
    },
  },
  slump2: {
    hips: [0, -0.06, 0], sq: 0.9, bob: 0.03, mood: 'sad', tailBase: 30,
    rot: {
      body: [32, 0, 0], head: [30, 0, -8],
      armL: [8, 0, 2], foreL: [-2, 0, 0], armR: [8, 0, -2], foreR: [-2, 0, 0], racket: [122, 0, 0],
      legL: [0, 0, -4], legR: [0, 0, 4], footL: [0, -20, 0], footR: [0, 20, 0],
      tail: [4, 0, 0],
    },
  },
};

// Probe-Pose -> gehaltene Schlüsselpose (Standbild)
export const TOY_STILL = { bereit: 'ready', laufen: 'run1', aus: 'windup', treffer: 'hit', jubel: 'jump', enttaeuscht: 'slump' };

export const TOY_CLIPS = {
  bereit: { loop: true, keys: [{ pose: 'ready', hold: 0.34 }, { pose: 'ready2', hold: 0.34 }] },
  laufen: {
    loop: true,
    keys: [{ pose: 'run1', hold: 0.1 }, { pose: 'run2', hold: 0.1 }, { pose: 'run3', hold: 0.1 }, { pose: 'run4', hold: 0.1 }],
    stumble: { pose: 'stumble', hold: 0.16, tween: 0.05, at: 'run3' },
  },
  aus: { loop: true, keys: [{ pose: 'ready', hold: 0.5 }, { pose: 'windup', hold: 0.32, tween: 0.09 }, { pose: 'hit', hold: 0.08, tween: 0.03 }, { pose: 'follow', hold: 0.45, tween: 0.06 }] },
  treffer: { loop: true, keys: [{ pose: 'ready', hold: 0.5 }, { pose: 'windup', hold: 0.32, tween: 0.09 }, { pose: 'hit', hold: 0.08, tween: 0.03 }, { pose: 'follow', hold: 0.45, tween: 0.06 }] },
  jubel: { loop: true, keys: [{ pose: 'crouch', hold: 0.14 }, { pose: 'jump', hold: 0.26, tween: 0.05 }, { pose: 'land', hold: 0.12, tween: 0.04 }, { pose: 'land', hold: 0.18 }] },
  enttaeuscht: { loop: true, keys: [{ pose: 'slump', hold: 0.7 }, { pose: 'slump2', hold: 0.7, tween: 0.15 }] },
};
