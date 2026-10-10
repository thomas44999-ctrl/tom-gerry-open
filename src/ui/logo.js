// Markenauftritt "Tom & Gerry Open" als Inline-SVG: Emblem, Wortmarke, Pokal, Spielerporträts.
// Jede Erzeugung bekommt eindeutige IDs (Gradienten in versteckten SVGs würden sonst kollidieren).

let _uid = 0;
const uid = (p) => `${p}${(++_uid).toString(36)}`;
const FONT = `-apple-system, 'SF Pro Display', 'Helvetica Neue', 'Segoe UI', Inter, Roboto, sans-serif`;
const SERIF = `'Didot', 'Bodoni 72', 'Playfair Display', Georgia, 'Times New Roman', serif`;

/** Rundes Emblem: Tennisball mit Katzenohren über dem Netz, Goldring mit Umschrift. */
export function emblemSVG({ text = true, cls = 'tg-emblem' } = {}) {
  const g = uid('em'), bg = uid('eb'), ball = uid('ebl'), clip = uid('ec'), net = uid('en'), top = uid('et'), bot = uid('ebt'), bclip = uid('ebc'), shine = uid('es');
  const ringText = text ? `
    <path id="${top}" d="M11 60 A49 49 0 0 1 109 60" fill="none"/>
    <path id="${bot}" d="M6 60 A54 54 0 0 0 114 60" fill="none"/>
    <text font-family="${FONT}" font-size="7.6" font-weight="700" letter-spacing="2.4" fill="#EBD28C">
      <textPath href="#${top}" startOffset="50%" text-anchor="middle">TOM &amp; GERRY OPEN</textPath></text>
    <text font-family="${FONT}" font-size="6.4" font-weight="600" letter-spacing="2.6" fill="#EBD28C" fill-opacity=".85">
      <textPath href="#${bot}" startOffset="50%" text-anchor="middle">CENTRE COURT</textPath></text>
    <circle cx="8.6" cy="60" r="1.6" fill="#EBD28C"/><circle cx="111.4" cy="60" r="1.6" fill="#EBD28C"/>` : '';
  const innerR = text ? 46.5 : 52;
  return `<svg class="${cls}" viewBox="0 0 120 120" aria-hidden="true">
  <defs>
    <linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#F8E39A"/><stop offset=".45" stop-color="#D9B45A"/><stop offset="1" stop-color="#94681F"/></linearGradient>
    <radialGradient id="${bg}" cx=".5" cy=".34" r=".72">
      <stop offset="0" stop-color="#1C6B46"/><stop offset=".7" stop-color="#0A3524"/><stop offset="1" stop-color="#05231A"/></radialGradient>
    <radialGradient id="${ball}" cx=".36" cy=".3" r=".85">
      <stop offset="0" stop-color="#F4FB9A"/><stop offset=".5" stop-color="#D6EC42"/><stop offset="1" stop-color="#93B21E"/></radialGradient>
    <linearGradient id="${shine}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <clipPath id="${clip}"><circle cx="60" cy="60" r="${innerR}"/></clipPath>
    <clipPath id="${bclip}"><circle cx="60" cy="55" r="19"/></clipPath>
    <pattern id="${net}" width="4.6" height="4.6" patternUnits="userSpaceOnUse" patternTransform="rotate(45 60 60)">
      <path d="M0 0H4.6M0 0V4.6" stroke="#F6EFDF" stroke-opacity=".42" stroke-width=".75"/></pattern>
  </defs>
  <circle cx="60" cy="60" r="59" fill="url(#${g})"/>
  <circle cx="60" cy="60" r="56.6" fill="url(#${bg})"/>
  ${ringText}
  <circle cx="60" cy="60" r="${innerR + 0.9}" fill="none" stroke="url(#${g})" stroke-width="1.5"/>
  <g clip-path="url(#${clip})">
    <rect x="0" y="0" width="120" height="120" fill="url(#${bg})"/>
    <g opacity=".22">${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${8 + i * 18}" y="0" width="9" height="120" fill="#2E8A57"/>`).join('')}</g>
    <path d="M10 92 Q60 70 110 92" fill="none" stroke="#F6EFDF" stroke-opacity=".18" stroke-width="1"/>
    <rect x="0" y="81" width="120" height="40" fill="url(#${net})"/>
    <rect x="0" y="78.6" width="120" height="3.6" fill="#F6EFDF"/>
    <rect x="0" y="82.2" width="120" height="1.2" fill="#000" opacity=".25"/>
    <ellipse cx="60" cy="77.8" rx="14" ry="1.6" fill="#000" opacity=".28"/>
    <g>
      <path d="M44.9 47.6 41.4 30.6 55 39.9Z" fill="#C7DF36" stroke="#C7DF36" stroke-width="3.2" stroke-linejoin="round"/>
      <path d="M75.1 47.6 78.6 30.6 65 39.9Z" fill="#B8D02C" stroke="#B8D02C" stroke-width="3.2" stroke-linejoin="round"/>
      <path d="M46.3 44.3 44.4 35.4 51.6 40.4Z" fill="#F08A2B"/>
      <path d="M73.7 44.3 75.6 35.4 68.4 40.4Z" fill="#F08A2B"/>
      <circle cx="60" cy="55" r="19" fill="url(#${ball})"/>
      <g clip-path="url(#${bclip})" fill="none" stroke="#FFFFFF" stroke-width="2.3" stroke-linecap="round">
        <path d="M44.2 41.5 C53.5 49 53.5 61 44.2 68.5"/>
        <path d="M75.8 41.5 C66.5 49 66.5 61 75.8 68.5"/>
      </g>
      <circle cx="60" cy="55" r="19" fill="url(#${shine})"/>
    </g>
  </g>
</svg>`;
}

/** Wortmarke + Emblem. layout: 'horizontal' (Titel, links) | 'stacked' (Loader, zentriert) */
export function logoSVG({ layout = 'horizontal', cls = 'tg-logo', subtitle = 'CENTRE COURT · FINALE' } = {}) {
  const gold = uid('lg'), cream = uid('lc'), line = uid('ll'), fadeL = uid('lfl'), fadeR = uid('lfr');
  const defs = `<defs>
    <linearGradient id="${gold}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FBE7A6"/><stop offset=".55" stop-color="#DDB85E"/><stop offset="1" stop-color="#B28A35"/></linearGradient>
    <linearGradient id="${cream}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#EFE5CC"/></linearGradient>
    <linearGradient id="${line}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#DDB85E" stop-opacity="0"/><stop offset=".15" stop-color="#DDB85E"/><stop offset=".85" stop-color="#DDB85E"/><stop offset="1" stop-color="#DDB85E" stop-opacity="0"/></linearGradient>
    <linearGradient id="${fadeL}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#DDB85E" stop-opacity="0"/><stop offset="1" stop-color="#DDB85E"/></linearGradient>
    <linearGradient id="${fadeR}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#DDB85E"/><stop offset="1" stop-color="#DDB85E" stop-opacity="0"/></linearGradient>
  </defs>`;
  const em = emblemSVG({ text: true, cls: 'tg-logo-emblem' }).replace('<svg ', '<svg x="X" y="Y" width="W" height="W" ');
  if (layout === 'stacked') {
    const e = em.replace('x="X"', 'x="130"').replace('y="Y"', 'y="0"').replace(/width="W" height="W"/, 'width="140" height="140"');
    return `<svg class="${cls}" viewBox="0 0 400 270" role="img" aria-label="Tom &amp; Gerry Open">${defs}
    ${e}
    <text x="200" y="196" text-anchor="middle" font-family="${FONT}" font-size="44" font-weight="800" fill="url(#${cream})" textLength="330" lengthAdjust="spacing">TOM <tspan font-family="${SERIF}" font-style="italic" font-weight="400" fill="url(#${gold})" font-size="48">&amp;</tspan> GERRY</text>
    <rect x="35" y="209" width="330" height="1" fill="url(#${line})" opacity=".55"/>
    <rect x="58" y="234.4" width="76" height="1.4" fill="url(#${fadeL})"/>
    <rect x="266" y="234.4" width="76" height="1.4" fill="url(#${fadeR})"/>
    <circle cx="140" cy="235.1" r="2.2" fill="#DDB85E"/><circle cx="260" cy="235.1" r="2.2" fill="#DDB85E"/>
    <text x="200" y="245" text-anchor="middle" font-family="${FONT}" font-size="29" font-weight="700" fill="url(#${gold})" textLength="104" lengthAdjust="spacing">OPEN</text>
    <text x="200" y="266" text-anchor="middle" font-family="${FONT}" font-size="9.5" font-weight="600" fill="#F6EFDF" fill-opacity=".72" letter-spacing="4.2">${subtitle}</text>
  </svg>`;
  }
  const e = em.replace('x="X"', 'x="0"').replace('y="Y"', 'y="2"').replace(/width="W" height="W"/, 'width="124" height="124"');
  return `<svg class="${cls}" viewBox="0 0 430 128" role="img" aria-label="Tom &amp; Gerry Open">${defs}
    ${e}
    <text x="144" y="58" font-family="${FONT}" font-size="45" font-weight="800" fill="url(#${cream})" textLength="282" lengthAdjust="spacing">TOM <tspan font-family="${SERIF}" font-style="italic" font-weight="400" fill="url(#${gold})" font-size="49">&amp;</tspan> GERRY</text>
    <rect x="144" y="70.5" width="282" height="1" fill="url(#${line})" opacity=".55"/>
    <text x="145" y="103" font-family="${FONT}" font-size="30" font-weight="700" fill="url(#${gold})" textLength="106" lengthAdjust="spacing">OPEN</text>
    <circle cx="265" cy="92.2" r="2.3" fill="#DDB85E"/>
    <rect x="272" y="91.5" width="154" height="1.4" fill="url(#${fadeR})"/>
    <text x="145" y="123.5" font-family="${FONT}" font-size="9.6" font-weight="600" fill="#F6EFDF" fill-opacity=".7" letter-spacing="4.3">${subtitle}</text>
  </svg>`;
}

/** Siegerpokal (Gold, mit Tennisball als Deckelknauf). */
export function trophySVG(cls = 'tg-trophy') {
  const g = uid('tg'), g2 = uid('tg2'), hl = uid('th'), base = uid('tb'), ball = uid('tbl');
  return `<svg class="${cls}" viewBox="0 0 200 240" aria-hidden="true">
  <defs>
    <linearGradient id="${g}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8A5E1A"/><stop offset=".18" stop-color="#E9C66D"/><stop offset=".36" stop-color="#FFF1BE"/>
      <stop offset=".52" stop-color="#E2B957"/><stop offset=".78" stop-color="#B0842F"/><stop offset="1" stop-color="#6E4A12"/></linearGradient>
    <linearGradient id="${g2}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F7DC8A"/><stop offset="1" stop-color="#9C7023"/></linearGradient>
    <linearGradient id="${hl}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="${base}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0B2E1F"/><stop offset=".45" stop-color="#1E5C3E"/><stop offset="1" stop-color="#071F15"/></linearGradient>
    <radialGradient id="${ball}" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#F4FB9A"/><stop offset="1" stop-color="#9DBB22"/></radialGradient>
  </defs>
  <ellipse cx="100" cy="230" rx="62" ry="7" fill="#000" opacity=".35"/>
  <path d="M52 50 C18 46 14 96 58 106" fill="none" stroke="url(#${g2})" stroke-width="9" stroke-linecap="round"/>
  <path d="M148 50 C182 46 186 96 142 106" fill="none" stroke="url(#${g2})" stroke-width="9" stroke-linecap="round"/>
  <path d="M44 38 H156 C156 92 138 122 112 132 L112 150 C112 158 126 162 126 170 H74 C74 162 88 158 88 150 L88 132 C62 122 44 92 44 38Z" fill="url(#${g})"/>
  <path d="M44 38 H156 C156 44 155.6 49 155 54 H45 C44.4 49 44 44 44 38Z" fill="#000" opacity=".12"/>
  <ellipse cx="100" cy="38" rx="56" ry="7.5" fill="url(#${g2})"/>
  <ellipse cx="100" cy="38" rx="49" ry="5" fill="#6E4A12" opacity=".55"/>
  <path d="M58 46 C60 84 72 108 90 120" fill="none" stroke="url(#${hl})" stroke-width="5" stroke-linecap="round" opacity=".8"/>
  <path d="M70 66 H130" stroke="#7A5216" stroke-opacity=".45" stroke-width="1.4"/>
  <path d="M74 74 H126" stroke="#FFF1BE" stroke-opacity=".5" stroke-width="1"/>
  <circle cx="100" cy="24" r="12" fill="url(#${ball})"/>
  <path d="M91 15.6c4.6 4 4.6 12.8 0 16.8M109 15.6c-4.6 4-4.6 12.8 0 16.8" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  <rect x="66" y="170" width="68" height="10" rx="2" fill="url(#${g})"/>
  <path d="M60 180 H140 L146 222 H54Z" fill="url(#${base})"/>
  <path d="M60 180 H140 L141 186 H59Z" fill="#E2B957" opacity=".85"/>
  <rect x="76" y="194" width="48" height="16" rx="2" fill="url(#${g})" opacity=".95"/>
  <path d="M80 202 H120" stroke="#6E4A12" stroke-width="1.2" opacity=".6"/>
</svg>`;
}

/** Stilisiertes Porträt: 'tom' (dunkle Haare, hellblaues Shirt) oder 'gerry' (orange Katze). */
export function portraitSVG(id, cls = 'tg-portrait') {
  const bg = uid('pb'), skin = uid('ps'), shirt = uid('psh'), clip = uid('pc'), fur = uid('pf'), eye = uid('pe');
  if (id === 'gerry') {
    return `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true">
  <defs>
    <radialGradient id="${bg}" cx=".5" cy=".3" r=".8"><stop offset="0" stop-color="#7A3A12"/><stop offset="1" stop-color="#2A1206"/></radialGradient>
    <radialGradient id="${fur}" cx=".45" cy=".35" r=".75"><stop offset="0" stop-color="#FFB25E"/><stop offset=".6" stop-color="#F08A2B"/><stop offset="1" stop-color="#C9661B"/></radialGradient>
    <radialGradient id="${eye}" cx=".5" cy=".45" r=".6"><stop offset="0" stop-color="#E9F59A"/><stop offset="1" stop-color="#8DBA2E"/></radialGradient>
    <clipPath id="${clip}"><circle cx="50" cy="50" r="50"/></clipPath>
  </defs>
  <g clip-path="url(#${clip})">
    <rect width="100" height="100" fill="url(#${bg})"/>
    <path d="M8 106 C10 84 28 76 50 76 C72 76 90 84 92 106Z" fill="#F7F3EA"/>
    <path d="M38 77 L50 88 L62 77" fill="none" stroke="#F08A2B" stroke-width="3" stroke-linejoin="round"/>
    <path d="M24 44 L22 12 L46 30Z" fill="url(#${fur})" stroke="#C9661B" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M76 44 L78 12 L54 30Z" fill="url(#${fur})" stroke="#C9661B" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M27.5 36 L26.5 19 L39.5 29Z" fill="#F4A6A0"/>
    <path d="M72.5 36 L73.5 19 L60.5 29Z" fill="#F4A6A0"/>
    <ellipse cx="50" cy="51" rx="27" ry="24" fill="url(#${fur})"/>
    <path d="M24.5 40 C34 33 66 33 75.5 40 L76.5 46 C66 40 34 40 23.5 46Z" fill="#FFFFFF"/>
    <path d="M24 43 C34 37 66 37 76 43" stroke="#F08A2B" stroke-width="1.6" fill="none"/>
    <path d="M44 47 l2 5 M50 46.5 v6 M56 47 l-2 5" stroke="#B4561A" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M24.5 54 h7 M24 59 h6.5 M75.5 54 h-7 M76 59 h-6.5" stroke="#B4561A" stroke-width="1.8" stroke-linecap="round"/>
    <ellipse cx="39.5" cy="55" rx="6.4" ry="6" fill="url(#${eye})"/>
    <ellipse cx="60.5" cy="55" rx="6.4" ry="6" fill="url(#${eye})"/>
    <ellipse cx="39.5" cy="55.4" rx="1.9" ry="4.8" fill="#11160A"/>
    <ellipse cx="60.5" cy="55.4" rx="1.9" ry="4.8" fill="#11160A"/>
    <circle cx="41.4" cy="52.6" r="1.4" fill="#fff"/><circle cx="62.4" cy="52.6" r="1.4" fill="#fff"/>
    <ellipse cx="44.6" cy="66" rx="7" ry="5.6" fill="#FFF6EA"/>
    <ellipse cx="55.4" cy="66" rx="7" ry="5.6" fill="#FFF6EA"/>
    <path d="M47 62 h6 l-3 3.2z" fill="#E77B83" stroke="#C85E66" stroke-width=".8" stroke-linejoin="round"/>
    <path d="M50 65.2 v2.4 M50 67.6 q-2.6 2.4 -5 .6 M50 67.6 q2.6 2.4 5 .6" stroke="#7B3A1A" stroke-width="1.2" fill="none" stroke-linecap="round"/>
    <path d="M36 66 l-14 -2 M36 69 l-14 2 M64 66 l14 -2 M64 69 l14 2" stroke="#FFF6EA" stroke-width=".9" stroke-linecap="round" opacity=".9"/>
  </g>
</svg>`;
  }
  return `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true">
  <defs>
    <radialGradient id="${bg}" cx=".5" cy=".3" r=".8"><stop offset="0" stop-color="#2F7299"/><stop offset="1" stop-color="#0A2433"/></radialGradient>
    <linearGradient id="${skin}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F5CDA8"/><stop offset="1" stop-color="#E0A47D"/></linearGradient>
    <linearGradient id="${shirt}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#B3E1FA"/><stop offset="1" stop-color="#6FB5E2"/></linearGradient>
    <clipPath id="${clip}"><circle cx="50" cy="50" r="50"/></clipPath>
  </defs>
  <g clip-path="url(#${clip})">
    <rect width="100" height="100" fill="url(#${bg})"/>
    <path d="M8 106 C10 84 28 75 50 75 C72 75 90 84 92 106Z" fill="url(#${shirt})"/>
    <path d="M43 63 h14 v12 q-7 5 -14 0z" fill="#D69670"/>
    <path d="M39 75 L50 86 L61 75" fill="none" stroke="#FFFFFF" stroke-width="3.2" stroke-linejoin="round"/>
    <ellipse cx="28.6" cy="48" rx="4.2" ry="6.2" fill="#E6AA84"/>
    <ellipse cx="71.4" cy="48" rx="4.2" ry="6.2" fill="#E6AA84"/>
    <ellipse cx="50" cy="45" rx="21.5" ry="23.5" fill="url(#${skin})"/>
    <path d="M28.4 46 C25.5 26 37 16.5 51.5 16.8 C66 17 76 26.5 71.8 46 C70.6 38 67.6 33.2 62 31 C54 34.5 41 34.6 33.4 31.6 C30.6 35.4 29 40 28.4 46Z" fill="#2B1C14"/>
    <path d="M33.4 31.6 C41 25.6 57 23.6 67 30.4 C59 28.4 49.6 30.6 43.4 35.2Z" fill="#3D2819"/>
    <path d="M37.6 40.6 q5 -3 9.4 -.4 M53 40.2 q4.4 -2.6 9.4 .4" stroke="#2B1C14" stroke-width="2.4" stroke-linecap="round" fill="none"/>
    <ellipse cx="42.4" cy="47.6" rx="3.1" ry="3.7" fill="#1C2A38"/>
    <ellipse cx="57.6" cy="47.6" rx="3.1" ry="3.7" fill="#1C2A38"/>
    <circle cx="43.5" cy="46.3" r="1.1" fill="#fff"/><circle cx="58.7" cy="46.3" r="1.1" fill="#fff"/>
    <path d="M50.2 49.6 q-2.2 5 .8 6.2" stroke="#C4825E" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <path d="M42.6 58 q7.4 5.4 14.8 0" stroke="#9A5440" stroke-width="2.3" fill="none" stroke-linecap="round"/>
    <ellipse cx="36" cy="55" rx="3.6" ry="2" fill="#F08A7A" opacity=".25"/><ellipse cx="64" cy="55" rx="3.6" ry="2" fill="#F08A7A" opacity=".25"/>
  </g>
</svg>`;
}
