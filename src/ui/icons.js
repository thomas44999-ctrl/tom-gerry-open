// Inline-SVG-Icons (24×24, currentColor). Alle Icons sind dekorativ (aria-hidden).

const S = (d) => `<svg class="tg-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const F = (d) => `<svg class="tg-ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;

export const ICONS = {
  play: F('<path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z" fill="currentColor"/>'),
  ball: F('<circle cx="12" cy="12" r="10" fill="#D7EE4B"/><path d="M12 2a10 10 0 0 1 0 20 10 10 0 0 0 6.4-10A10 10 0 0 0 12 2z" fill="#9DBB22" opacity=".35"/><path d="M4.4 5.4c3.9 3.2 3.9 10 0 13.2M19.6 5.4c-3.9 3.2-3.9 10 0 13.2" stroke="#fff" stroke-width="1.7" fill="none" stroke-linecap="round"/>'),
  user: S('<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20c.9-3.9 3.7-6 7.2-6s6.3 2.1 7.2 6"/>'),
  cat: S('<path d="M4.9 9.6 5.5 3.9l4.1 3.1a8.2 8.2 0 0 1 4.8 0l4.1-3.1.6 5.7A7.4 7.4 0 0 1 20 13c0 4-3.6 7-8 7s-8-3-8-7a7.4 7.4 0 0 1 .9-3.4z"/><path d="M9.3 12.8v.4M14.7 12.8v.4"/><path d="M11 15.6h2l-1 1.1z"/>'),
  gauge: S('<path d="M3.8 17.5a8.2 8.2 0 1 1 16.4 0"/><path d="m12 17.5 4.2-5.2"/><circle cx="12" cy="17.5" r="1.2" fill="currentColor"/>'),
  court: S('<rect x="3.5" y="4.5" width="17" height="15" rx="1.6"/><path d="M3.5 12h17M7 4.5v15M17 4.5v15M7 8.2h10M7 15.8h10M12 8.2v7.6"/>'),
  eye: S('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  sparkle: S('<path d="M12 3.2 13.9 10 20.8 12l-6.9 2L12 20.8 10.1 14 3.2 12l6.9-2z"/>'),
  sound: S('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.6 9a4.2 4.2 0 0 1 0 6M18.2 6.4a7.8 7.8 0 0 1 0 11.2"/>'),
  mute: S('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5m0-5-5 5"/>'),
  voice: S('<path d="M4.5 6.6a2.1 2.1 0 0 1 2.1-2.1h10.8a2.1 2.1 0 0 1 2.1 2.1v7.8a2.1 2.1 0 0 1-2.1 2.1H11l-4.5 3.5v-3.5a2.1 2.1 0 0 1-2-2.1z"/><path d="M8.5 9.4h7M8.5 12.2h4.5"/>'),
  gamepad: S('<path d="M7.2 7.5h9.6a4.6 4.6 0 0 1 4.5 5.6l-.9 3.9a2.4 2.4 0 0 1-4.1 1.1l-2.2-2.6H9.9l-2.2 2.6A2.4 2.4 0 0 1 3.6 17l-.9-3.9a4.6 4.6 0 0 1 4.5-5.6z"/><path d="M7.6 10.4v3.2M6 12h3.2"/><circle cx="15.8" cy="11" r=".7" fill="currentColor"/><circle cx="17.6" cy="13" r=".7" fill="currentColor"/>'),
  keyboard: S('<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 9.6h.01M9 9.6h.01M12 9.6h.01M15 9.6h.01M18 9.6h.01M7.5 14.4h9"/>'),
  restart: S('<path d="M4.6 12a7.4 7.4 0 1 0 2.2-5.3"/><path d="M4.6 4.4v4.2h4.2"/>'),
  home: S('<path d="M4 11 12 4.5 20 11"/><path d="M6.5 9.5V19h11V9.5"/><path d="M10 19v-5h4v5"/>'),
  chevL: S('<path d="m14.5 6-6 6 6 6"/>'),
  chevR: S('<path d="m9.5 6 6 6-6 6"/>'),
  replay: S('<path d="M19.5 12A7.5 7.5 0 1 1 17.3 6.7"/><path d="M19.6 4.3v4.4h-4.4"/><path d="M10.3 9.2v5.6l4.6-2.8z" fill="currentColor" stroke="none"/>'),
  radar: S('<path d="M4 18.5a10 10 0 0 1 16 0"/><path d="M7.4 18.5a6 6 0 0 1 9.2 0"/><path d="m12 18.5 4.8-7.4"/><circle cx="12" cy="18.5" r="1.1" fill="currentColor"/>'),
  pause: F('<rect x="6.5" y="5" width="3.8" height="14" rx="1.1" fill="currentColor"/><rect x="13.7" y="5" width="3.8" height="14" rx="1.1" fill="currentColor"/>'),
  trophy: S('<path d="M8 4.5h8v5a4 4 0 0 1-8 0z"/><path d="M8 6.2H5.2v1.3A3 3 0 0 0 8 10.4M16 6.2h2.8v1.3a3 3 0 0 1-2.8 2.9"/><path d="M12 13.6v3.2M8.8 19.5h6.4M9.8 16.8h4.4v2.7H9.8z"/>'),
  close: S('<path d="m6.5 6.5 11 11m0-11-11 11"/>'),
  target: S('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".9" fill="currentColor"/>'),
  bolt: S('<path d="M13 3 5.5 13.5H12L11 21l7.5-10.5H12z"/>'),
  swap: S('<path d="M4 8.5h14.5M15 5l3.5 3.5L15 12"/><path d="M20 15.5H5.5M9 12l-3.5 3.5L9 19"/>'),
  camera: S('<path d="M4 8.2h3l1.6-2.2h6.8L17 8.2h3v10H4z"/><circle cx="12" cy="13" r="3.2"/>'),
  info: S('<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.2M12 7.8v.2"/>'),
};

/** Icon-HTML holen (leer, falls unbekannt). */
export const icon = (name) => ICONS[name] || '';
