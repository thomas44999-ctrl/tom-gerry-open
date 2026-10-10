// Prozedurale Impulsantwort für ein offenes Tennisstadion (Centre Court ohne Dach).
// Charakter: kurz und luftig – frühe Reflexionen von Tribünenkante und Banden, ein deutliches
// "Slap"-Echo der gegenüberliegenden Tribüne (das typische TV-Tennis-"Pock … ock") und eine
// kurze, höhenarme Fahne. Reines JS (Node-testbar, deterministisch über seed).

/**
 * @param {number} sampleRate
 * @param {object} [o] { length=1.6 s, rt60=1.15 (tiefe/mittlere Frequenzen), rt60High=0.4,
 *                       tail=0.42 (Energieanteil Fahne), seed, slap=1 (Echo-Stärke), predelay=0.007 }
 * @returns {Float32Array[]} [L, R], Energie je Kanal auf 1 normiert (Faltungsgewinn ≈ 0 dB).
 */
export function stadiumIR(sampleRate, o = {}) {
  const sr = sampleRate;
  const len = Math.floor(sr * (o.length ?? 1.6));
  const rtLow = o.rt60 ?? 1.15, rtHigh = o.rt60High ?? 0.4;
  const slap = o.slap ?? 1, pre = o.predelay ?? 0.007;
  let seed = (o.seed ?? 0x5eed) >>> 0;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };

  const L = new Float32Array(len), R = new Float32Array(len);

  // Kurzer, verschmierter Reflexions-"Tap": Rauschimpuls mit Einheitsenergie, tiefpassgefiltert
  // (Luftdämpfung + raue Oberflächen), stereo platziert.
  const tap = (t, g, pan, smear, lpHz) => {
    const start = Math.floor((t + pre) * sr), n = Math.max(8, Math.floor(smear * sr));
    if (start >= len) return;
    const a = Math.exp(-2 * Math.PI * lpHz / sr);
    const tmp = new Float32Array(n);
    let lp = 0, e = 0;
    for (let i = 0; i < n; i++) {
      const env = Math.exp(-i / (n / 3.2)) * Math.min(1, i / 6);
      lp = lp * a + (1 - a) * rand() * env;
      tmp[i] = lp; e += lp * lp;
    }
    const k = g / Math.sqrt(e || 1);
    const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    for (let i = 0; i < n && start + i < len; i++) { L[start + i] += tmp[i] * k * gl * 1.41; R[start + i] += tmp[i] * k * gr * 1.41; }
  };

  // Frühe Reflexionen: Bandenwände, Schiedsrichterstuhl, Tribünenkanten (9–80 ms)
  const er = [[0.0090, 0.42, -0.5], [0.0135, 0.36, 0.6], [0.0190, 0.30, 0.1], [0.0260, 0.26, -0.8], [0.0330, 0.22, 0.75],
    [0.0410, 0.19, -0.25], [0.0520, 0.16, 0.4], [0.0640, 0.13, -0.6], [0.0780, 0.11, 0.2]];
  for (const [t, g, p] of er) tap(t * (1 + rand() * 0.05), g, p, 0.0012 + Math.abs(rand()) * 0.001, 9000 - t * 40000);
  // Slap-Echos der gegenüberliegenden Tribünen (~25–45 m Laufweg hin und zurück)
  tap(0.148, 0.20 * slap, -0.35, 0.010, 2900);
  tap(0.171, 0.17 * slap, 0.45, 0.013, 2500);
  tap(0.226, 0.085 * slap, 0.0, 0.022, 1800);
  tap(0.305, 0.040 * slap, 0.25, 0.035, 1300);

  // Diffuse Fahne: zwei Bänder mit unterschiedlicher Nachhallzeit (Höhen verklingen schneller),
  // Dichte baut sich langsam auf (offenes Stadion → wenig frühe Diffusion). L/R dekorreliert.
  const tl = new Float32Array(len), tr = new Float32Array(len);
  const aSplit = Math.exp(-2 * Math.PI * 1400 / sr);
  let lpl = 0, lpr = 0, e = 0;
  const k60l = 6.907755 / rtLow, k60h = 6.907755 / rtHigh;
  for (let i = Math.floor(pre * sr); i < len; i++) {
    const t = i / sr - pre;
    const on = t < 0.004 ? 0 : t > 0.1 ? 1 : ((t - 0.004) / 0.096) * ((t - 0.004) / 0.096) * (3 - 2 * ((t - 0.004) / 0.096));
    const el = Math.exp(-k60l * t), eh = Math.exp(-k60h * t);
    const nl = rand(), nr = rand();
    lpl = lpl * aSplit + (1 - aSplit) * nl; lpr = lpr * aSplit + (1 - aSplit) * nr;
    // Ende sanft ausblenden, damit kein Abschneiden hörbar ist
    const fade = i > len - sr * 0.15 ? (len - i) / (sr * 0.15) : 1;
    tl[i] = (lpl * el * 2.2 + (nl - lpl) * eh) * on * fade;
    tr[i] = (lpr * el * 2.2 + (nr - lpr) * eh) * on * fade;
    e += tl[i] * tl[i] + tr[i] * tr[i];
  }
  const tailE = o.tail ?? 0.42;
  const kt = Math.sqrt((tailE * 2) / (e || 1));
  for (let i = 0; i < len; i++) { L[i] += tl[i] * kt; R[i] += tr[i] * kt; }

  // Energie je Kanal auf 1 normieren
  for (const ch of [L, R]) {
    let s = 0; for (let i = 0; i < len; i++) s += ch[i] * ch[i];
    const k = 1 / Math.sqrt(s || 1);
    for (let i = 0; i < len; i++) ch[i] *= k;
  }
  return [L, R];
}

/** Kurze, dichte Raumantwort für Musik-Stings (weicher "Hall"-Glanz). */
export function plateIR(sampleRate, o = {}) {
  return stadiumIR(sampleRate, { length: o.length ?? 2.4, rt60: o.rt60 ?? 2.0, rt60High: o.rt60High ?? 1.1, tail: 0.85, slap: 0.15, predelay: 0.012, seed: 777 });
}
