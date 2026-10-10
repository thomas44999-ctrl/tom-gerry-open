// UI-Stylesheet als JS-String (wird einmalig per <style> injiziert).
// Skalierung: Wurzel-Schriftgröße = clamp(11px, 1.9vmin, 30px); alles andere in em.
// Animationen nur über transform/opacity (60 fps), Glas-Panels mit backdrop-filter.

export const UI_CSS = /* css */ `
.tg-ui {
  --g950: #03140d; --g900: #06261a; --g800: #0b3a27; --g700: #0f4d33; --g600: #166141; --g500: #1f7a4d;
  --cream: #f6efdf; --cream-2: #e9dfc6; --cream-dim: rgba(246, 239, 223, .72); --cream-faint: rgba(246, 239, 223, .42);
  --gold: #d9b45a; --gold-hi: #f3d98a; --gold-lo: #a37a2c;
  --red: #e5544b; --coral: #ff7a6b; --ok: #47d18c; --ball: #d7ee4b;
  --tom: #8ccbf2; --gerry: #f08a2b;
  --glass-bg: linear-gradient(180deg, rgba(14, 62, 41, .78), rgba(4, 28, 18, .86));
  --glass-line: rgba(246, 239, 223, .14);
  --shadow: 0 .9em 2.6em rgba(0, 0, 0, .38), 0 .15em .45em rgba(0, 0, 0, .28);
  --e-out: cubic-bezier(.16, 1, .3, 1); --e-in: cubic-bezier(.7, 0, .84, 0); --e-io: cubic-bezier(.65, 0, .35, 1);
  --e-back: cubic-bezier(.34, 1.56, .64, 1);
  position: absolute; inset: 0; z-index: 30; overflow: hidden; pointer-events: none;
  font-family: -apple-system, "SF Pro Display", "Helvetica Neue", "Segoe UI", Inter, Roboto, sans-serif;
  font-size: clamp(11px, 1.9vmin, 30px); line-height: 1.25; color: var(--cream);
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility;
  user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent;
}
.tg-ui.is-fixed { position: fixed; }
.tg-ui *, .tg-ui *::before, .tg-ui *::after { box-sizing: border-box; }
.tg-ui .tg-ico { display: block; width: 1em; height: 1em; flex: none; }
.tg-ui kbd {
  display: inline-grid; place-items: center; min-width: 1.7em; height: 1.55em; padding: 0 .4em; margin: 0 .12em;
  font: inherit; font-size: .86em; font-weight: 700; color: var(--cream); line-height: 1;
  background: linear-gradient(180deg, rgba(246, 239, 223, .16), rgba(246, 239, 223, .06));
  border: 1px solid rgba(246, 239, 223, .22); border-bottom-width: 2px; border-radius: .35em;
}
.tg-glass {
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(18px) saturate(1.45); backdrop-filter: blur(18px) saturate(1.45);
  border: 1px solid var(--glass-line);
  box-shadow: var(--shadow), inset 0 1px 0 rgba(255, 255, 255, .08);
}
.tg-ui.is-lowfx .tg-glass { -webkit-backdrop-filter: none; backdrop-filter: none; background: linear-gradient(180deg, rgba(10, 52, 34, .95), rgba(4, 26, 17, .96)); }

/* ================================================================ Menü-Einträge */
.tg-menu { display: flex; flex-direction: column; gap: .16em; }
.tg-item {
  -webkit-appearance: none; appearance: none; border: 0; margin: 0; background: transparent; outline: none;
  position: relative; display: flex; align-items: center; gap: .72em; width: 100%; height: 2.3em; padding: 0 .75em 0 .95em;
  border-radius: .5em; color: var(--cream); font: inherit; font-size: 1em; font-weight: 600; letter-spacing: .01em;
  text-align: left; cursor: pointer; pointer-events: auto;
  transition: background-color .2s, transform .28s var(--e-out), color .2s, box-shadow .2s;
}
.tg-item::before {
  content: ''; position: absolute; left: .18em; top: .5em; bottom: .5em; width: .2em; border-radius: .1em;
  background: var(--gold-hi); box-shadow: 0 0 .6em rgba(243, 217, 138, .8);
  transform: scaleY(0); transition: transform .28s var(--e-out);
}
.tg-item.is-focus {
  background: linear-gradient(90deg, rgba(243, 217, 138, .2), rgba(243, 217, 138, .06) 65%, rgba(243, 217, 138, .02));
  box-shadow: inset 0 0 0 1px rgba(243, 217, 138, .38);
  transform: translateX(.28em);
}
.tg-item.is-focus::before { transform: scaleY(1); }
.tg-item:focus-visible { outline: none; }
.tg-item-ico { width: 1.22em; height: 1.22em; display: grid; place-items: center; color: var(--gold); flex: none; transition: transform .3s var(--e-back); }
.tg-item-ico .tg-ico { width: 100%; height: 100%; }
.tg-item.is-focus .tg-item-ico { transform: scale(1.12); color: var(--gold-hi); }
.tg-item-l { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tg-item.is-dim .tg-item-l, .tg-item.is-dim .tg-opt-v { opacity: .45; }
.tg-item-go { width: 1.1em; height: 1.1em; opacity: .4; transition: opacity .2s, transform .3s var(--e-out); }
.tg-item-go .tg-ico { width: 100%; height: 100%; }
.tg-item.is-focus .tg-item-go { opacity: 1; transform: translateX(.2em); color: var(--gold-hi); }
.tg-opt { display: flex; align-items: center; gap: .15em; font-weight: 700; flex: none; }
.tg-opt-a { width: 1.15em; height: 1.15em; display: grid; place-items: center; opacity: .28; font-style: normal; transition: opacity .2s, transform .2s, color .2s; }
.tg-opt-a .tg-ico { width: 100%; height: 100%; }
.tg-item.is-focus .tg-opt-a { opacity: 1; color: var(--gold-hi); }
.tg-item.is-focus .tg-opt-prev:hover { transform: translateX(-.12em); }
.tg-item.is-focus .tg-opt-next:hover { transform: translateX(.12em); }
.tg-opt-v { display: inline-flex; align-items: baseline; justify-content: center; gap: .3em; min-width: 11em; font-size: .92em; white-space: nowrap; }
.tg-opt-v small { font-size: .78em; font-weight: 600; opacity: .7; }
.tg-opt-v .tg-chip { align-self: center; margin-right: .1em; }
.tg-chip { display: inline-block; width: .62em; height: .62em; border-radius: 50%; box-shadow: 0 0 0 .14em rgba(255, 255, 255, .14), 0 0 .5em currentColor; }
.tg-chip-tom { background: var(--tom); color: var(--tom); }
.tg-chip-gerry { background: var(--gerry); color: var(--gerry); }
.tg-item-primary {
  height: auto; flex-wrap: wrap; row-gap: .1em; padding: .78em 1em .72em 1.05em; margin-bottom: .2em;
  background: linear-gradient(135deg, #fbe9a8 0%, #e2bd62 46%, #b8892f 100%); color: #1d1606; overflow: hidden;
  box-shadow: 0 .5em 1.4em rgba(217, 180, 90, .28), inset 0 1px 0 rgba(255, 255, 255, .65), inset 0 -1px 0 rgba(0, 0, 0, .2);
}
.tg-item-primary::before { display: none; }
.tg-item-primary .tg-item-ico { color: #1d1606; width: 1.35em; height: 1.35em; }
.tg-item-primary .tg-item-l { font-size: 1.24em; font-weight: 850; letter-spacing: .07em; text-transform: uppercase; }
.tg-item-primary.is-focus {
  background: linear-gradient(135deg, #fff1bd 0%, #ecc86c 46%, #c39436 100%); color: #1d1606;
  box-shadow: 0 .6em 1.8em rgba(243, 217, 138, .45), 0 0 0 .14em rgba(243, 217, 138, .55), inset 0 1px 0 rgba(255, 255, 255, .7);
  transform: translateX(.28em);
}
.tg-item-primary.is-focus .tg-item-ico { color: #1d1606; }
.tg-item-sub { flex-basis: 100%; padding-left: 2.07em; font-size: .74em; font-weight: 650; opacity: .72; letter-spacing: .01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tg-item-shine {
  position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(105deg, transparent 35%, rgba(255, 255, 255, .55) 50%, transparent 65%);
  transform: translateX(-110%);
}
.tg-item-primary.is-focus .tg-item-shine { animation: tgShine 3.2s ease-in-out 1s infinite; }
.tg-item-compact { height: 2.5em; padding: 0 1em; flex-wrap: nowrap; }
.tg-item-compact .tg-item-l { font-size: 1.05em; }
.tg-item.is-confirm { background: linear-gradient(90deg, rgba(229, 84, 75, .32), rgba(229, 84, 75, .08)); box-shadow: inset 0 0 0 1px rgba(255, 122, 107, .55); }
.tg-item.is-confirm .tg-item-ico { color: var(--coral); }
.tg-menu-sep { display: flex; align-items: center; gap: .9em; padding: .75em .3em .4em 1.35em; font-size: .64em; font-weight: 700; letter-spacing: .24em; text-transform: uppercase; color: var(--cream-faint); }
.tg-menu-sep::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(246, 239, 223, .2), transparent); }

/* ================================================================ Loader */
.tg-loader { position: absolute; inset: 0; display: none; pointer-events: auto; background: var(--g950); z-index: 50; overflow: hidden; }
.tg-loader.is-on { display: block; }
.tg-loader.is-out { animation: tgFadeOut .8s var(--e-io) forwards; }
.tg-loader-bg {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 60% 55% at 50% 40%, rgba(38, 128, 80, .55), rgba(38, 128, 80, 0) 70%),
    repeating-linear-gradient(90deg, rgba(255, 255, 255, .028) 0 7vmin, rgba(255, 255, 255, 0) 7vmin 14vmin),
    linear-gradient(180deg, #082d1e 0%, #04190f 70%, #020c07 100%);
}
.tg-loader-bg::after { content: ''; position: absolute; inset: 0; background: radial-gradient(ellipse 85% 80% at 50% 45%, transparent 55%, rgba(0, 0, 0, .55)); }
.tg-loader-beam {
  position: absolute; left: 50%; top: -30%; width: 34vmax; height: 140%; margin-left: -17vmax;
  background: linear-gradient(90deg, rgba(255, 236, 190, 0), rgba(255, 236, 190, .07) 50%, rgba(255, 236, 190, 0));
  transform-origin: 50% 0; transform: rotate(24deg); animation: tgBeam 9s ease-in-out infinite alternate;
}
.tg-loader-beam-2 { animation-duration: 12s; animation-delay: -5s; opacity: .7; }
.tg-loader-center { position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 1.5em; }
.tg-loader-logo { animation: tgRise 1.1s var(--e-out) both; }
.tg-loader-logo .tg-logo { display: block; width: 25em; height: auto; filter: drop-shadow(0 .5em 1.6em rgba(0, 0, 0, .55)); }
.tg-loader-bar { position: relative; width: 22em; height: .26em; border-radius: .13em; background: rgba(246, 239, 223, .1); overflow: hidden; animation: tgFadeIn .8s .3s both; }
.tg-loader-fill { position: absolute; inset: 0; transform-origin: 0 50%; transform: scaleX(0); background: linear-gradient(90deg, #8e6a26, #d9b45a 60%, #fbe7a6); }
.tg-loader-head { position: absolute; top: 0; bottom: 0; left: 0; width: 100%; transform: translateX(0); }
.tg-loader-head::after { content: ''; position: absolute; right: 100%; top: -.3em; bottom: -.3em; width: 3em; margin-right: -1.5em; background: radial-gradient(ellipse at center, rgba(255, 244, 205, .95), rgba(255, 244, 205, 0) 70%); }
.tg-loader-row { width: 22em; display: flex; justify-content: space-between; align-items: baseline; font-size: .76em; font-weight: 650; letter-spacing: .16em; text-transform: uppercase; color: var(--cream-dim); margin-top: -.6em; animation: tgFadeIn .8s .4s both; }
.tg-loader-row { width: calc(22em / .76); }
.tg-loader-pct { color: var(--gold-hi); font-variant-numeric: tabular-nums; font-weight: 800; }
.tg-loader-tip { position: absolute; left: 50%; bottom: 3.4em; transform: translateX(-50%); width: min(42em, 88vw); display: flex; flex-direction: column; align-items: center; gap: .6em; text-align: center; animation: tgFadeIn 1s .6s both; }
.tg-loader-k { font-size: .66em; font-weight: 800; letter-spacing: .3em; text-transform: uppercase; color: var(--gold); padding: .3em .9em; border: 1px solid rgba(217, 180, 90, .45); border-radius: 2em; }
.tg-loader-t { font-size: .98em; line-height: 1.45; color: var(--cream-dim); max-width: 34em; text-wrap: balance; }

/* ================================================================ Titel */
.tg-title { position: absolute; inset: 0; display: none; }
.tg-title.is-on { display: block; }
.tg-title-scrim {
  position: absolute; inset: 0; animation: tgFadeIn 1s both;
  background:
    radial-gradient(ellipse 42% 38% at 20% 20%, rgba(3, 20, 13, .55), rgba(3, 20, 13, 0) 100%),
    linear-gradient(90deg, rgba(3, 20, 13, .86) 0%, rgba(3, 20, 13, .66) 26%, rgba(3, 20, 13, .2) 48%, rgba(3, 20, 13, 0) 62%),
    linear-gradient(0deg, rgba(3, 20, 13, .55) 0%, rgba(3, 20, 13, 0) 28%);
}
.tg-title-panel { position: absolute; left: 4.4em; top: 50%; width: 30.5em; transform: translateY(-50%); display: flex; flex-direction: column; gap: 1.15em; pointer-events: auto; }
.tg-title-logo { animation: tgSlideR 1s var(--e-out) .05s both; }
.tg-title-logo .tg-logo { display: block; width: 100%; height: auto; filter: drop-shadow(0 .4em 1.2em rgba(0, 0, 0, .55)); }
.tg-title-card { border-radius: .95em; padding: .65em; animation: tgSlideR 1s var(--e-out) .18s both; }
.tg-title .tg-menu > * { animation: tgItemIn .7s var(--e-out) both; }
.tg-title .tg-menu > *:nth-child(1) { animation-delay: .26s; } .tg-title .tg-menu > *:nth-child(2) { animation-delay: .3s; }
.tg-title .tg-menu > *:nth-child(3) { animation-delay: .33s; } .tg-title .tg-menu > *:nth-child(4) { animation-delay: .36s; }
.tg-title .tg-menu > *:nth-child(5) { animation-delay: .39s; } .tg-title .tg-menu > *:nth-child(6) { animation-delay: .42s; }
.tg-title .tg-menu > *:nth-child(7) { animation-delay: .45s; } .tg-title .tg-menu > *:nth-child(8) { animation-delay: .48s; }
.tg-title .tg-menu > *:nth-child(9) { animation-delay: .51s; } .tg-title .tg-menu > *:nth-child(10) { animation-delay: .54s; }
.tg-hints { display: flex; flex-wrap: wrap; align-items: center; gap: .5em 1.2em; padding-left: .5em; font-size: .74em; font-weight: 600; color: var(--cream-dim); animation: tgFadeIn 1s .7s both; }
.tg-hints-pad { display: inline-flex; align-items: center; gap: .45em; color: var(--cream-faint); }
.tg-hints-pad .tg-ico { width: 1.35em; height: 1.35em; }
.tg-title-foot { position: absolute; right: 2.2em; bottom: 1.7em; display: flex; align-items: center; gap: .7em; font-size: .66em; font-weight: 700; letter-spacing: .24em; text-transform: uppercase; color: var(--cream-faint); animation: tgFadeIn 1.2s 1s both; }
.tg-title-foot::before { content: ''; width: 2.6em; height: 1px; background: linear-gradient(90deg, transparent, rgba(217, 180, 90, .7)); }
.tg-title.is-out .tg-title-panel { animation: tgSlideOutL .5s var(--e-in) forwards; }
.tg-title.is-out .tg-title-scrim, .tg-title.is-out .tg-title-foot { animation: tgFadeOut .5s var(--e-in) forwards; }

/* ================================================================ HUD */
.tg-hud { position: absolute; inset: 0; opacity: 0; transition: opacity .45s; }
.tg-hud.is-on { opacity: 1; }
.tg-hud-tl { position: absolute; left: 1.6em; top: 1.5em; display: flex; flex-direction: column; align-items: flex-start; transform: translateX(-130%); transition: transform .8s var(--e-out), opacity .4s; }
.tg-hud.is-on .tg-hud-tl { transform: none; }
.tg-hud.is-replay .tg-hud-tl { opacity: 0; transform: translateY(-1em); }
.tg-ui.is-modal .tg-hud { opacity: 0; }
.tg-bug { position: relative; display: flex; align-items: stretch; border-radius: .6em; font-variant-numeric: tabular-nums; z-index: 2; }
.tg-bug-emblem {
  width: 3.7em; display: grid; place-items: center; flex: none; border-radius: .6em 0 0 .6em;
  background: radial-gradient(circle at 50% 40%, rgba(31, 122, 77, .5), rgba(3, 20, 13, .2) 70%);
  border-right: 1px solid rgba(217, 180, 90, .32);
}
.tg-bug-emblem-svg { width: 2.75em; height: 2.75em; display: block; filter: drop-shadow(0 .1em .3em rgba(0, 0, 0, .5)); }
.tg-bug-rows { display: flex; flex-direction: column; }
.tg-row {
  --pc: #fff; position: relative; display: grid; align-items: center; height: 2.08em;
  grid-template-columns: var(--namew, 6em) 1.45em auto 2.15em 2.9em;
}
.tg-row + .tg-row { box-shadow: inset 0 1px 0 rgba(246, 239, 223, .09); }
.tg-row::before { content: ''; position: absolute; left: 0; top: .34em; bottom: .34em; width: .22em; border-radius: 0 .2em .2em 0; background: var(--pc); box-shadow: 0 0 .6em var(--pc); }
.tg-row::after { content: ''; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(90deg, color-mix(in srgb, var(--pc) 20%, transparent), transparent 60%); }
.tg-name { padding-left: .85em; font-size: .98em; font-weight: 780; letter-spacing: .1em; white-space: nowrap; position: relative; z-index: 1; }
.tg-serve { display: grid; place-items: center; position: relative; z-index: 1; }
.tg-serve .tg-ico { width: .74em; height: .74em; opacity: 0; transform: scale(0); transition: opacity .3s, transform .4s var(--e-back); }
.tg-row.is-serving .tg-serve .tg-ico { opacity: 1; transform: none; filter: drop-shadow(0 0 .28em rgba(215, 238, 75, .75)); }
.tg-sets { display: flex; position: relative; z-index: 1; }
.tg-set { position: relative; width: 1.55em; text-align: center; font-weight: 600; color: var(--cream-faint); }
.tg-set.is-won { color: var(--cream); font-weight: 800; }
.tg-tb { position: absolute; top: -.35em; right: 0; font-size: .58em; font-weight: 700; color: var(--cream-dim); }
.tg-games { align-self: stretch; display: grid; place-items: center; font-size: 1.06em; font-weight: 850; background: rgba(246, 239, 223, .07); box-shadow: inset 1px 0 0 rgba(246, 239, 223, .08); position: relative; z-index: 1; }
.tg-pts { align-self: stretch; display: grid; place-items: center; overflow: hidden; position: relative; z-index: 1; background: linear-gradient(180deg, #fbf6e8, #e9ddc0); color: var(--g900); }
.tg-row-0 .tg-pts { border-top-right-radius: .6em; }
.tg-row-1 .tg-pts { border-bottom-right-radius: .6em; box-shadow: inset 0 1px 0 rgba(6, 38, 26, .14); }
.tg-pts-v { display: block; font-size: 1.08em; font-weight: 850; letter-spacing: -.01em; }
.tg-pts.is-ad { background: linear-gradient(180deg, #fbe7a6, #d9b45a); color: #2a1c05; }
.tg-bug.is-tiebreak .tg-pts { background: linear-gradient(180deg, #fbe7a6, #dcbc66); }
.tg-bug-tab {
  position: absolute; right: 0; bottom: 100%; margin-bottom: -.05em; padding: .32em .7em .3em; border-radius: .45em .45em 0 0;
  font-size: .56em; font-weight: 850; letter-spacing: .22em; color: #2a1c05; background: linear-gradient(180deg, #fbe7a6, #d9b45a);
  opacity: 0; transform: translateY(40%); transition: opacity .3s, transform .45s var(--e-out);
}
.tg-bug.is-tiebreak .tg-bug-tab { opacity: 1; transform: none; }
.tg-flag-wrap { display: none; overflow: hidden; margin-left: 3.7em; padding: 0 .5em .6em 0; }
.tg-flag-wrap.is-on { display: block; }
.tg-flag {
  position: relative; display: flex; align-items: center; gap: .55em; height: 1.85em; padding: 0 .85em 0 .7em; overflow: hidden;
  border-radius: 0 0 .5em .5em; font-size: .8em; font-weight: 850; letter-spacing: .16em; white-space: nowrap;
  box-shadow: 0 .4em 1em rgba(0, 0, 0, .3); animation: tgFlagIn .6s var(--e-out) both;
}
.tg-flag-break { background: linear-gradient(180deg, #ef5f55, #b83229); color: #fff; }
.tg-flag-set { background: linear-gradient(180deg, #f6dc8f, #c99a3e); color: #2a1c05; }
.tg-flag-match { background: linear-gradient(90deg, #fff0b8, #e2bd62 45%, #fbe7a6 70%, #c99a3e); color: #241703; }
.tg-flag-dot { width: .52em; height: .52em; border-radius: 50%; background: currentColor; animation: tgPulse 1.1s ease-in-out infinite; font-style: normal; }
.tg-flag-p { display: flex; align-items: center; gap: .45em; padding-left: .7em; margin-left: .1em; box-shadow: inset 1px 0 0 currentColor; font-weight: 750; letter-spacing: .12em; }
.tg-flag-p:empty { display: none; }
.tg-flag-p::before { content: ''; width: .55em; height: .55em; border-radius: 50%; background: var(--pc); box-shadow: 0 0 0 .12em rgba(255, 255, 255, .5); }
.tg-flag-shine { position: absolute; inset: 0; background: linear-gradient(105deg, transparent 35%, rgba(255, 255, 255, .5) 50%, transparent 65%); transform: translateX(-110%); animation: tgShine 2.6s ease-in-out .7s infinite; }
.tg-speed-wrap { display: none; margin-top: .45em; }
.tg-speed-wrap.is-on { display: block; animation: tgSpeedIn .55s var(--e-out) both; }
.tg-speed-wrap.is-out { animation: tgSpeedOut .4s var(--e-in) forwards; }
.tg-speed { display: flex; align-items: baseline; gap: .45em; padding: .42em .95em .42em .75em; border-radius: .55em; }
.tg-speed .tg-ico { width: 1.15em; height: 1.15em; color: var(--gold); align-self: center; }
.tg-speed-l { font-size: .68em; font-weight: 750; letter-spacing: .16em; text-transform: uppercase; color: var(--cream-dim); margin-right: .2em; }
.tg-speed-v { min-width: 2em; text-align: right; font-size: 1.42em; font-weight: 850; font-variant-numeric: tabular-nums; }
.tg-speed-u { font-size: .74em; font-weight: 750; color: var(--gold-hi); }

/* Laderinge */
.tg-charge, .tg-meter, .tg-timing { position: absolute; left: 0; top: 0; width: 0; height: 0; will-change: transform; }
.tg-charge-in { position: absolute; left: -2.1em; top: -2.1em; width: 4.2em; height: 4.2em; opacity: 0; transform: scale(.55); transition: opacity .14s, transform .3s var(--e-back); }
.tg-charge.is-on .tg-charge-in { opacity: 1; transform: none; }
.tg-charge svg { width: 100%; height: 100%; display: block; transform: rotate(-90deg); overflow: visible; }
.tg-charge-ticks { fill: none; stroke: rgba(246, 239, 223, .42); stroke-width: 1.5; stroke-dasharray: 1 4; }
.tg-charge-trk { fill: rgba(3, 20, 13, .32); stroke: rgba(3, 20, 13, .55); stroke-width: 6.5; }
.tg-charge-arc { fill: none; stroke: var(--pc, #fff); stroke-width: 5; stroke-linecap: round; filter: drop-shadow(0 0 2.5px var(--pc, #fff)); transition: stroke .2s; }
.tg-charge-core { fill: var(--cream); opacity: .85; transform-origin: 32px 32px; transition: transform .2s, fill .2s; }
.tg-charge.is-max .tg-charge-arc { stroke: var(--gold-hi); filter: drop-shadow(0 0 4px #f3d98a); }
.tg-charge.is-max .tg-charge-core { fill: var(--gold-hi); transform: scale(1.35); }
.tg-charge.is-max .tg-charge-in { animation: tgThrob .5s ease-in-out infinite alternate; }

/* Aufschlag-Meter (Anker = unten links, rechts neben dem Spieler). Vertikal = Ballwurf-Höhe, der Ball fährt mit. */
.tg-meter-in { position: absolute; left: 1.6em; bottom: 0; width: 3em; padding: .62em 0 .95em; border-radius: 1.5em; display: flex; flex-direction: column; align-items: center; gap: .75em; opacity: 0; transform: translateX(-.8em) scale(.92); transform-origin: 0 100%; transition: opacity .18s, transform .35s var(--e-out); }
.tg-meter.is-on .tg-meter-in { opacity: 1; transform: none; }
.tg-meter-l { font-size: .5em; font-weight: 850; letter-spacing: .14em; text-transform: uppercase; color: var(--cream-dim); }
.tg-meter-track {
  position: relative; width: .6em; height: 9.2em; border-radius: .3em;
  background: repeating-linear-gradient(0deg, rgba(246, 239, 223, .12) 0 1px, rgba(0, 0, 0, 0) 1px 10%), linear-gradient(180deg, rgba(0, 0, 0, .55), rgba(0, 0, 0, .32));
  box-shadow: inset 0 0 0 1px rgba(246, 239, 223, .16), inset 0 .2em .4em rgba(0, 0, 0, .45);
}
.tg-meter-zone { position: absolute; left: -.28em; right: -.28em; bottom: 78%; height: 14%; border-radius: .3em; background: linear-gradient(180deg, #fff0b8, #d9b45a 55%, #b8892f); opacity: .8; box-shadow: 0 0 .5em rgba(243, 217, 138, .5), inset 0 1px 0 rgba(255, 255, 255, .6); transition: opacity .15s, box-shadow .15s; }
.tg-meter-zone b { position: absolute; right: 100%; top: 50%; margin-right: .5em; transform: translateY(-50%); font-size: .5em; font-weight: 900; letter-spacing: .14em; text-transform: uppercase; color: var(--gold-hi); white-space: nowrap; text-shadow: 0 .1em .3em rgba(0, 0, 0, .8); }
.tg-meter-fill { position: absolute; inset: 0; border-radius: .3em; transform-origin: 50% 100%; transform: scaleY(0); background: linear-gradient(0deg, rgba(246, 239, 223, .04), rgba(246, 239, 223, .5)); }
.tg-meter-mark { position: absolute; inset: 0; }
.tg-meter-mark i { position: absolute; left: 50%; bottom: 0; width: 1.3em; height: 1.3em; margin: 0 0 -.65em -.65em; border-radius: 50%; box-shadow: 0 0 0 .1em rgba(255, 255, 255, .85), 0 .15em .4em rgba(0, 0, 0, .55); transition: box-shadow .12s; }
.tg-meter-mark .tg-ico { width: 100%; height: 100%; }
.tg-meter.is-hot .tg-meter-zone { opacity: 1; box-shadow: 0 0 1.2em rgba(243, 217, 138, 1), inset 0 1px 0 rgba(255, 255, 255, .8); }
.tg-meter.is-hot .tg-meter-mark i { box-shadow: 0 0 0 .12em var(--gold-hi), 0 0 1em .2em rgba(243, 217, 138, .9); }

/* Timing-Feedback (kleine Plakette am Spieler) */
.tg-timing span {
  position: absolute; left: 0; top: 0; opacity: 0; white-space: nowrap; padding: .26em .7em .24em; border-radius: .45em;
  font-size: 1em; font-weight: 900; font-style: italic; letter-spacing: .05em; text-transform: uppercase;
  background: linear-gradient(180deg, rgba(6, 38, 26, .82), rgba(3, 20, 13, .82)); box-shadow: 0 .3em .9em rgba(0, 0, 0, .35), inset 0 0 0 1px var(--tc, rgba(246, 239, 223, .3));
  color: var(--tc, var(--cream)); text-shadow: 0 .05em .2em rgba(0, 0, 0, .5);
}
.tg-timing-perfect span { --tc: #ffe39a; font-size: 1.15em; box-shadow: 0 0 1.1em rgba(243, 217, 138, .55), 0 .3em .9em rgba(0, 0, 0, .35), inset 0 0 0 1px rgba(243, 217, 138, .85); }
.tg-timing-good span { --tc: #bfe9cf; }
.tg-timing-bad span { --tc: #ff9a8c; }
.tg-timing-meh span { --tc: var(--cream-dim); }

/* ================================================================ Banner */
.tg-banners { position: absolute; left: 0; right: 0; top: 29%; height: 0; }
.tg-banner { --ac: #f3d98a; --band: rgba(5, 34, 22, .9); position: absolute; left: 50%; top: 0; transform: translate(-50%, -50%); }
.tg-banner-in { position: relative; display: flex; flex-direction: column; align-items: center; padding: .4em 3em .75em; text-align: center; }
.tg-banner-band {
  position: absolute; left: 50%; top: 0; bottom: 0; width: 64em; margin-left: -32em; overflow: hidden;
  background: linear-gradient(90deg, rgba(0, 0, 0, 0), var(--band) 20%, var(--band) 80%, rgba(0, 0, 0, 0));
  transform: skewX(-14deg) scaleX(0); animation: tgBandIn .5s var(--e-out) both;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent); mask-image: linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent);
}
.tg-banner-band::before { content: ''; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(255, 255, 255, .07), rgba(255, 255, 255, 0) 45%, rgba(0, 0, 0, .18)); }
.tg-banner-band::after { content: ''; position: absolute; inset: 0; background: radial-gradient(ellipse 40% 120% at 50% 50%, color-mix(in srgb, var(--ac) 22%, transparent), transparent 70%); }
.tg-banner-sweep { position: absolute; top: 0; bottom: 0; left: 0; width: 30%; background: linear-gradient(90deg, rgba(255, 255, 255, 0), rgba(255, 255, 255, .22), rgba(255, 255, 255, 0)); transform: translateX(-120%); animation: tgSweep 1.1s var(--e-io) .25s both; }
.tg-banner-line { position: absolute; left: 50%; width: 40em; margin-left: -20em; height: 2px; background: linear-gradient(90deg, rgba(0, 0, 0, 0), var(--ac) 30%, var(--ac) 70%, rgba(0, 0, 0, 0)); opacity: 0; }
.tg-banner-line-t { top: -.45em; animation: tgLineL .7s var(--e-out) .08s both; }
.tg-banner-line-b { bottom: -.45em; animation: tgLineR .7s var(--e-out) .08s both; }
.tg-banner-kick { position: relative; margin-bottom: .1em; font-size: .78em; font-weight: 800; letter-spacing: .42em; text-transform: uppercase; color: var(--ac); animation: tgSubIn .5s var(--e-out) .1s both; }
.tg-banner-echo {
  position: absolute; left: 50%; top: 50%; white-space: nowrap; font-size: 9em; font-weight: 900; font-style: italic; line-height: 1; letter-spacing: .04em;
  color: transparent; -webkit-text-stroke: 1px var(--ac); opacity: 0; transform: translate(-42%, -50%);
  animation: tgEcho 2.4s cubic-bezier(.2, .6, .4, 1) both;
}
.tg-banner-title { position: relative; display: flex; flex-wrap: nowrap; justify-content: center; white-space: nowrap; font-size: 5em; font-weight: 900; font-style: italic; line-height: 1.04; letter-spacing: .015em; filter: drop-shadow(0 .05em .1em rgba(0, 0, 0, .45)); }
.tg-bw { display: inline-flex; }
.tg-banner-pc { align-self: center; width: .78em; height: .78em; margin: 0 .3em 0 0; border-radius: 50%; overflow: hidden; flex: none; box-shadow: 0 0 0 .045em var(--pc), 0 .06em .2em rgba(0, 0, 0, .5); animation: tgPortrait .7s var(--e-back) .15s both; }
.tg-banner-pc svg { display: block; width: 100%; height: 100%; }
.tg-bsp { display: inline-block; width: .28em; }
.tg-bl {
  display: inline-block; padding: 0 .02em;
  background: linear-gradient(180deg, #ffffff 10%, #fff7df 48%, var(--ac) 100%); -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: tgLetter .62s var(--e-out) both; animation-delay: calc(var(--i) * 26ms + 90ms);
}
.tg-banner-sub { position: relative; margin-top: .15em; font-size: 1em; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: var(--cream); animation: tgSubIn .55s var(--e-out) .32s both; }
.tg-banner.tg-b-md { top: -16vh; }
.tg-b-md .tg-banner-title { font-size: 3.1em; }
.tg-b-md .tg-banner-echo { font-size: 6em; }
.tg-b-xl .tg-banner-echo { font-size: 11em; }
.tg-b-md .tg-banner-band { width: 46em; margin-left: -23em; }
.tg-b-md .tg-banner-line { width: 28em; margin-left: -14em; }
.tg-b-xl .tg-banner-title { font-size: 6.2em; }
.tg-b-xl .tg-banner-band { width: 80em; margin-left: -40em; }
.tg-b-xl .tg-banner-line { width: 52em; margin-left: -26em; height: 3px; }
.tg-banner.is-out .tg-banner-in { animation: tgBannerOut .42s var(--e-in) forwards; }
.tg-banner-fx { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.tg-burst { position: absolute; left: -8em; top: -8em; width: 16em; height: 16em; border-radius: 50%; border: .22em solid var(--ac); opacity: 0; animation: tgBurst .95s var(--e-out) .05s both; }
.tg-burst-2 { border-width: .1em; animation-delay: .18s; animation-duration: 1.2s; }
.tg-confetti i { position: absolute; left: -.2em; top: -.35em; width: .4em; height: .7em; border-radius: .08em; background: var(--c); opacity: 0; animation: tgConfetti 1.9s cubic-bezier(.2, .7, .3, 1) both; animation-delay: calc(var(--d) + .15s); }

/* ================================================================ Toasts */
.tg-toasts { position: absolute; left: 50%; top: 1.5em; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: .45em; }
.tg-toast { display: flex; align-items: center; gap: .55em; padding: .48em 1.15em .48em .8em; border-radius: 2em; font-size: .9em; font-weight: 650; white-space: nowrap; animation: tgToastIn .5s var(--e-out) both; }
.tg-toast .tg-ico { width: 1.2em; height: 1.2em; color: var(--gold); }
.tg-toast.is-out { animation: tgToastOut .36s var(--e-in) forwards; }

/* ================================================================ Pause */
.tg-pause { position: absolute; inset: 0; display: none; place-items: center; pointer-events: auto; background: radial-gradient(ellipse at 50% 45%, rgba(4, 26, 17, .5), rgba(1, 10, 6, .82)); -webkit-backdrop-filter: blur(5px) saturate(.85); backdrop-filter: blur(5px) saturate(.85); }
.tg-pause.is-on { display: grid; animation: tgFadeIn .28s both; }
.tg-pause.is-out { animation: tgFadeOut .3s var(--e-in) forwards; }
.tg-pause-panel { width: 25em; padding: 1.25em 1.1em 1em; border-radius: 1em; animation: tgPop .5s var(--e-out) both; }
.tg-pause-head { display: flex; align-items: center; justify-content: center; gap: .55em; font-size: 1.5em; font-weight: 900; font-style: italic; letter-spacing: .14em; text-transform: uppercase; }
.tg-pause-ico { width: .9em; height: .9em; color: var(--gold); }
.tg-pause-ico .tg-ico { width: 100%; height: 100%; }
.tg-pause-score { margin: .6em .4em .9em; padding: .55em .8em; border-radius: .6em; background: rgba(0, 0, 0, .22); box-shadow: inset 0 0 0 1px rgba(246, 239, 223, .08); display: flex; flex-direction: column; align-items: center; gap: .2em; font-variant-numeric: tabular-nums; }
.tg-ps-line { display: flex; align-items: center; gap: .55em; font-weight: 800; }
.tg-ps-line b { font-size: 1.15em; min-width: 1.1em; text-align: center; }
.tg-ps-line i { font-style: normal; opacity: .5; }
.tg-ps-n { display: inline-flex; align-items: center; gap: .4em; font-size: .86em; letter-spacing: .12em; }
.tg-ps-n::before { content: ''; width: .5em; height: .5em; border-radius: 50%; background: var(--pc); box-shadow: 0 0 .4em var(--pc); }
.tg-ps-pts { font-size: .8em; color: var(--cream-dim); gap: .4em; }
.tg-ps-pts b { color: var(--gold-hi); }
.tg-ps-meta { font-size: .9em; font-weight: 600; letter-spacing: .14em; color: var(--cream-dim); margin-left: .6em; }
.tg-pause-foot { margin-top: .8em; text-align: center; font-size: .72em; color: var(--cream-faint); font-weight: 600; }

/* ================================================================ Steuerung */
.tg-controls { position: absolute; inset: 0; display: none; place-items: center; pointer-events: auto; background: rgba(1, 10, 6, .62); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }
.tg-controls.is-on { display: grid; animation: tgFadeIn .25s both; }
.tg-controls.is-out { animation: tgFadeOut .28s var(--e-in) forwards; }
.tg-controls-panel { width: min(56em, 94vw); max-height: 94vh; padding: 1.1em 1.5em 1em; border-radius: 1.05em; display: flex; flex-direction: column; gap: .95em; animation: tgPop .5s var(--e-out) both; }
.tg-controls-head { display: flex; align-items: center; justify-content: space-between; }
.tg-controls-title { display: flex; align-items: center; gap: .55em; font-size: 1.35em; font-weight: 900; font-style: italic; letter-spacing: .12em; text-transform: uppercase; }
.tg-controls-title .tg-ico { width: 1.15em; height: 1.15em; color: var(--gold); }
.tg-close { -webkit-appearance: none; appearance: none; border: 0; outline: none; width: 2.2em; height: 2.2em; display: grid; place-items: center; border-radius: 50%; color: var(--cream); background: rgba(246, 239, 223, .08); cursor: pointer; pointer-events: auto; transition: background .2s, transform .3s var(--e-back); }
.tg-close .tg-ico { width: 1.1em; height: 1.1em; }
.tg-close.is-focus { background: rgba(243, 217, 138, .22); box-shadow: 0 0 0 .12em rgba(243, 217, 138, .6); transform: rotate(90deg); }
.tg-controls-grid { display: grid; grid-template-columns: 1.05fr 1fr; gap: 1em; }
.tg-cs { position: relative; border-radius: .8em; padding: .85em 1em 1em; background: rgba(0, 0, 0, .2); box-shadow: inset 0 0 0 1px rgba(246, 239, 223, .08); }
.tg-cs h3 { margin: 0 0 .75em; display: flex; align-items: center; gap: .5em; font-size: .7em; font-weight: 800; letter-spacing: .24em; text-transform: uppercase; color: var(--gold); }
.tg-cs h3 .tg-ico { width: 1.5em; height: 1.5em; }
.tg-cs-kb { display: flex; flex-direction: column; }
.tg-kb { display: flex; flex-direction: column; gap: .95em; flex: 1; justify-content: space-between; }
.tg-kb-serve { padding-top: .75em; box-shadow: inset 0 1px 0 rgba(246, 239, 223, .08); }
.tg-kb-step { display: flex; align-items: center; gap: .5em; }
.tg-kb-step span { font-size: .74em; font-weight: 750; color: var(--cream); white-space: nowrap; }
.tg-kb-arrow { width: 1em; height: 1em; color: var(--gold); opacity: .8; }
.tg-kb-arrow .tg-ico { width: 100%; height: 100%; }
.tg-kb-group { display: flex; align-items: center; gap: .8em; flex-wrap: wrap; }
.tg-kb-cluster { display: flex; flex-direction: column; align-items: center; gap: .18em; }
.tg-kb-row { display: flex; gap: .18em; }
.tg-kb-or { font-size: .7em; color: var(--cream-faint); font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.tg-kb-cap { margin-left: auto; font-size: .82em; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: var(--cream); padding: .3em .7em; border-radius: .4em; background: rgba(246, 239, 223, .08); }
.tg-key {
  display: inline-grid !important; place-items: center; min-width: 2.1em !important; height: 2.1em !important; margin: 0 !important; padding: 0 .5em !important;
  font-size: .82em !important; font-weight: 800 !important; border-radius: .42em !important;
  background: linear-gradient(180deg, #fbf6e8, #ddd2b6) !important; color: var(--g900) !important;
  border: 0 !important; box-shadow: 0 .18em 0 #9f9478, 0 .3em .5em rgba(0, 0, 0, .35), inset 0 1px 0 #fff;
}
.tg-key-wide { min-width: 7.5em !important; }
.tg-kb-acts { display: grid; grid-template-columns: repeat(4, 1fr); gap: .5em; }
.tg-act { display: flex; flex-direction: column; align-items: center; gap: .45em; }
.tg-act span { font-size: .74em; font-weight: 750; letter-spacing: .06em; color: var(--cream); display: flex; align-items: center; gap: .4em; }
.tg-act span::before { content: ''; width: .5em; height: .5em; border-radius: 50%; background: var(--ac); box-shadow: 0 0 .4em var(--ac); }
.tg-act .tg-key { box-shadow: 0 .18em 0 #9f9478, 0 .3em .5em rgba(0, 0, 0, .35), inset 0 -.2em 0 var(--ac), inset 0 1px 0 #fff; }
.tg-kb-extra { display: flex; gap: 1.2em; align-items: flex-start; }
.tg-kb-extra .tg-act { flex-direction: row; gap: .3em; }
.tg-kb-extra .tg-act span { margin-left: .35em; }
.tg-cs-pad { display: flex; flex-direction: column; }
.tg-pad { display: block; width: 72%; height: auto; margin: -.1em auto .5em; filter: drop-shadow(0 .5em .8em rgba(0, 0, 0, .35)); }
.tg-pad text { font-family: inherit; }
.tg-pad-legend { display: grid; grid-template-columns: 1fr 1fr; gap: .42em 1em; margin-top: auto; }
.tg-pl { display: flex; align-items: center; gap: .55em; font-size: .78em; font-weight: 700; color: var(--cream); white-space: nowrap; }
.tg-pb { display: inline-grid; place-items: center; flex: none; width: 1.75em; height: 1.75em; border-radius: 50%; font-size: .86em; font-weight: 850; color: var(--ac); background: color-mix(in srgb, var(--ac) 20%, transparent); box-shadow: inset 0 0 0 .13em var(--ac); }
.tg-pb-wide { width: auto; padding: 0 .6em; border-radius: .9em; font-size: .7em; height: 2.15em; letter-spacing: .06em; }
.tg-tips { display: grid; grid-template-columns: repeat(4, 1fr); gap: .7em; }
.tg-tip { display: flex; gap: .6em; padding: .7em .75em; border-radius: .7em; background: rgba(246, 239, 223, .05); box-shadow: inset 0 0 0 1px rgba(246, 239, 223, .07); }
.tg-tip > .tg-ico { width: 1.4em; height: 1.4em; color: var(--gold); margin-top: .05em; }
.tg-tip div { display: flex; flex-direction: column; gap: .25em; }
.tg-tip b { font-size: .82em; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
.tg-tip span { font-size: .74em; line-height: 1.42; color: var(--cream-dim); }
.tg-controls-foot { display: flex; justify-content: flex-end; font-size: .74em; color: var(--cream-faint); font-weight: 600; }
.tg-controls-foot span { display: inline-flex; align-items: center; gap: .35em; }
.tg-controls-foot .tg-ico { width: 1.3em; height: 1.3em; }

/* ================================================================ Match-Ende */
.tg-end { position: absolute; inset: 0; display: none; pointer-events: auto; }
.tg-end.is-on { display: block; }
.tg-end.is-out { animation: tgFadeOut .45s var(--e-in) forwards; }
.tg-end-scrim { position: absolute; inset: 0; background: radial-gradient(ellipse 60% 75% at 27% 46%, rgba(16, 80, 52, .62), rgba(2, 14, 9, .9) 72%), rgba(2, 14, 9, .35); -webkit-backdrop-filter: blur(8px) saturate(1.1); backdrop-filter: blur(8px) saturate(1.1); animation: tgFadeIn .8s both; }
.tg-end-wrap { position: absolute; inset: 0; display: grid; grid-template-columns: minmax(0, .92fr) minmax(0, 1.08fr); align-items: center; gap: 2.4em; padding: 2em 3.6em; }
.tg-end-hero { position: relative; display: flex; flex-direction: column; align-items: center; text-align: center; }
.tg-end-rays {
  position: absolute; left: 50%; top: 7.5em; width: 34em; height: 34em; margin: -17em 0 0 -17em; border-radius: 50%; opacity: 0;
  background: repeating-conic-gradient(from 0deg, rgba(243, 217, 138, .16) 0deg 7deg, rgba(243, 217, 138, 0) 7deg 18deg);
  -webkit-mask-image: radial-gradient(circle, #000 18%, transparent 68%); mask-image: radial-gradient(circle, #000 18%, transparent 68%);
  animation: tgRaysIn 1.4s var(--e-out) .3s forwards, tgSpin 60s linear infinite;
}
.tg-end-confetti { position: absolute; left: 50%; top: 7.5em; width: 0; height: 0; }
.tg-end-confetti i { position: absolute; left: -.22em; top: -.4em; width: .44em; height: .8em; border-radius: .08em; background: var(--c); opacity: 0; animation: tgConfetti 2.4s cubic-bezier(.2, .7, .3, 1) both; animation-delay: calc(var(--d) + .75s); }
.tg-end-trophy { position: relative; width: 12em; animation: tgTrophy 1.3s var(--e-out) .25s both; }
.tg-end-trophy .tg-trophy { display: block; width: 100%; height: auto; filter: drop-shadow(0 .8em 1.6em rgba(0, 0, 0, .55)) drop-shadow(0 0 2.2em rgba(243, 217, 138, .3)); }
.tg-end-glint { position: absolute; left: 50%; top: 14%; width: 3.2em; height: 3.2em; margin-left: -4.2em; background: radial-gradient(circle, #fff 0, rgba(255, 255, 255, .6) 12%, rgba(255, 255, 255, 0) 60%); opacity: 0; animation: tgGlint 3.6s ease-in-out 1.6s infinite; }
.tg-end-glint::before, .tg-end-glint::after { content: ''; position: absolute; left: 50%; top: 50%; width: 4.4em; height: 2px; margin: -1px 0 0 -2.2em; background: linear-gradient(90deg, transparent, #fff, transparent); }
.tg-end-glint::after { transform: rotate(90deg); }
.tg-end-kicker { display: flex; align-items: center; gap: 1em; margin-top: .9em; font-size: .8em; font-weight: 850; letter-spacing: .5em; text-transform: uppercase; color: var(--gold-hi); animation: tgSubIn .7s var(--e-out) .9s both; }
.tg-end-kicker::before, .tg-end-kicker::after { content: ''; width: 3.2em; height: 1px; background: linear-gradient(90deg, transparent, var(--gold)); }
.tg-end-kicker::after { transform: scaleX(-1); }
.tg-end-name { display: flex; align-items: center; gap: .3em; margin-top: .15em; animation: tgNameIn .9s var(--e-out) 1.05s both; }
.tg-end-portrait { width: 4.6em; height: 4.6em; border-radius: 50%; overflow: hidden; box-shadow: 0 0 0 .2em var(--wc), 0 0 1.6em color-mix(in srgb, var(--wc) 60%, transparent); flex: none; }
.tg-end-portrait svg { width: 100%; height: 100%; display: block; }
.tg-end-name-t { padding: 0 .12em 0 .18em; font-size: 4.8em; font-weight: 900; font-style: italic; letter-spacing: .01em; line-height: 1.05; background: linear-gradient(180deg, #ffffff 15%, var(--wc) 95%); -webkit-background-clip: text; background-clip: text; color: transparent; filter: drop-shadow(0 .06em .14em rgba(0, 0, 0, .5)); }
.tg-end-sets { display: flex; gap: .5em; margin-top: .55em; animation: tgSubIn .7s var(--e-out) 1.3s both; }
.tg-end-set { position: relative; display: flex; align-items: center; gap: .2em; padding: .3em .7em; border-radius: .45em; font-size: 1.15em; font-weight: 800; font-variant-numeric: tabular-nums; background: rgba(0, 0, 0, .28); box-shadow: inset 0 0 0 1px rgba(246, 239, 223, .1); color: var(--cream-dim); }
.tg-end-set.is-won { color: var(--cream); box-shadow: inset 0 0 0 1px rgba(243, 217, 138, .55); }
.tg-end-set i { font-style: normal; opacity: .45; }
.tg-end-set sup { font-size: .55em; margin-left: .1em; align-self: flex-start; }
.tg-end-meta { margin-top: .75em; font-size: .72em; font-weight: 650; letter-spacing: .2em; text-transform: uppercase; color: var(--cream-faint); animation: tgFadeIn .8s 1.5s both; }
.tg-end-side { display: flex; flex-direction: column; gap: 1em; min-width: 0; }
.tg-end-stats { border-radius: 1em; padding: .9em 1.15em .8em; animation: tgSlideL .9s var(--e-out) .7s both; }
.tg-stat-head { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding-bottom: .65em; margin-bottom: .3em; box-shadow: inset 0 -1px 0 rgba(246, 239, 223, .1); }
.tg-sh { display: flex; align-items: center; gap: .6em; font-weight: 850; letter-spacing: .12em; font-size: .95em; }
.tg-sh-b { justify-content: flex-end; }
.tg-sh-p { width: 2.3em; height: 2.3em; border-radius: 50%; box-shadow: 0 0 0 .14em var(--pc); display: block; }
.tg-sh-mid { font-size: .64em; font-weight: 800; letter-spacing: .3em; text-transform: uppercase; color: var(--gold); }
.tg-stat-list { display: flex; flex-direction: column; }
.tg-stat { display: grid; grid-template-columns: 5.4em 1fr 5.4em; align-items: center; min-height: 1.98em; animation: tgRowIn .6s var(--e-out) both; animation-delay: calc(var(--i) * 45ms + .95s); }
.tg-stat + .tg-stat { box-shadow: inset 0 1px 0 rgba(246, 239, 223, .055); }
.tg-stat-v { display: flex; align-items: baseline; gap: .4em; font-variant-numeric: tabular-nums; }
.tg-stat-v b { font-size: .98em; font-weight: 800; color: var(--cream-dim); }
.tg-stat-v b small { font-size: .62em; font-weight: 700; opacity: .8; }
.tg-stat-v.is-best b { color: #fff; }
.tg-stat-b { justify-content: flex-start; flex-direction: row-reverse; }
.tg-stat-sub { font-size: .64em; font-weight: 600; color: var(--cream-faint); }
.tg-stat-mid { display: flex; flex-direction: column; align-items: center; gap: .26em; padding: .22em 0; }
.tg-stat-l { font-size: .72em; font-weight: 700; letter-spacing: .05em; color: var(--cream-dim); white-space: nowrap; }
.tg-stat-bars { display: grid; grid-template-columns: 1fr 1fr; gap: .3em; width: 100%; max-width: 15em; }
.tg-bar { display: block; height: .3em; border-radius: .15em; background: currentColor; opacity: .32; transform: scaleX(var(--w)); animation: tgBarIn .9s var(--e-out) both; animation-delay: calc(var(--i) * 45ms + 1.1s); }
.tg-bar-a { color: var(--ca); transform-origin: 100% 50%; }
.tg-bar-b { color: var(--cb); transform-origin: 0 50%; }
.tg-bar.is-best { opacity: 1; box-shadow: 0 0 .5em currentColor; }
.tg-stat-single { grid-template-columns: 1fr; justify-items: center; gap: .1em; padding: .25em 0; }
.tg-stat-one { font-size: .98em; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--gold-hi); }
.tg-end-actions { display: flex; justify-content: flex-end; gap: .7em; animation: tgSubIn .7s var(--e-out) 1.7s both; }
.tg-end-actions .tg-item { width: auto; min-width: 11.5em; justify-content: center; }
.tg-end-actions .tg-item-l { flex: none; }
.tg-end-actions .tg-item:not(.tg-item-primary) { background: rgba(246, 239, 223, .07); box-shadow: inset 0 0 0 1px rgba(246, 239, 223, .16); }
.tg-end-actions .tg-item:not(.tg-item-primary).is-focus { background: rgba(243, 217, 138, .16); box-shadow: inset 0 0 0 1px rgba(243, 217, 138, .6); }
.tg-end-actions .tg-item.is-focus { transform: translateY(-.12em); }

/* ================================================================ Intro */
.tg-intro { position: absolute; inset: 0; display: none; }
.tg-intro.is-on { display: flex; flex-direction: column; justify-content: flex-end; padding: 0 3.2em 3.4em; }
.tg-intro-top { position: absolute; left: 50%; top: 2em; transform: translateX(-50%); display: flex; align-items: center; gap: .8em; padding: .5em 1.4em .5em .55em; border-radius: 3em; animation: tgIntroTop .9s var(--e-out) .1s both; }
.tg-intro-em { display: block; width: 2.6em; height: 2.6em; }
.tg-intro-top div { display: flex; flex-direction: column; line-height: 1.15; }
.tg-intro-top b { font-size: .92em; font-weight: 850; letter-spacing: .16em; text-transform: uppercase; color: var(--cream); }
.tg-intro-top span { font-size: .66em; font-weight: 750; letter-spacing: .3em; text-transform: uppercase; color: var(--gold-hi); }
.tg-intro.is-out .tg-intro-top { animation: tgFadeOut .4s forwards; }
.tg-intro-row { position: relative; display: flex; justify-content: space-between; align-items: stretch; }
.tg-intro-card { position: relative; width: 27.5em; display: flex; align-items: center; gap: 1.1em; padding: 1em 1.3em 1em 1.1em; border-radius: 1em; overflow: hidden; }
.tg-intro-l { animation: tgIntroL .9s var(--e-out) var(--d) both; }
.tg-intro-r { flex-direction: row-reverse; text-align: right; animation: tgIntroR .9s var(--e-out) var(--d) both; }
.tg-intro.is-out .tg-intro-l { animation: tgIntroOutL .5s var(--e-in) forwards; }
.tg-intro.is-out .tg-intro-r { animation: tgIntroOutR .5s var(--e-in) forwards; }
.tg-intro.is-out .tg-intro-vs { animation: tgFadeOut .4s forwards; }
.tg-intro-stripe { position: absolute; top: 0; bottom: 0; width: .35em; background: var(--pc); box-shadow: 0 0 1.2em var(--pc); }
.tg-intro-l .tg-intro-stripe { left: 0; }
.tg-intro-r .tg-intro-stripe { right: 0; }
.tg-intro-card::after { content: ''; position: absolute; inset: 0; pointer-events: none; background: radial-gradient(ellipse 60% 120% at 0% 50%, color-mix(in srgb, var(--pc) 26%, transparent), transparent 70%); }
.tg-intro-r::after { background: radial-gradient(ellipse 60% 120% at 100% 50%, color-mix(in srgb, var(--pc) 26%, transparent), transparent 70%); }
.tg-intro-portrait { position: relative; z-index: 1; width: 6.6em; height: 6.6em; border-radius: 50%; overflow: hidden; flex: none; box-shadow: 0 0 0 .2em var(--pc), 0 .5em 1.2em rgba(0, 0, 0, .45); animation: tgPortrait .9s var(--e-back) calc(var(--d) + .25s) both; }
.tg-intro-portrait svg { width: 100%; height: 100%; display: block; }
.tg-intro-body { position: relative; z-index: 1; flex: 1; min-width: 0; }
.tg-intro-seed { font-size: .62em; font-weight: 800; letter-spacing: .24em; text-transform: uppercase; color: var(--gold); }
.tg-intro-name { font-size: 2.55em; font-weight: 900; font-style: italic; line-height: 1.02; letter-spacing: .02em; color: #fff; animation: tgSubIn .7s var(--e-out) calc(var(--d) + .3s) both; }
.tg-intro-nick { margin-top: .05em; font-size: .92em; font-weight: 750; color: var(--pc); }
.tg-intro-facts { display: flex; flex-wrap: wrap; gap: .2em .9em; margin-top: .35em; font-size: .7em; font-weight: 650; letter-spacing: .04em; color: var(--cream-dim); }
.tg-intro-r .tg-intro-facts { justify-content: flex-end; }
.tg-intro-attrs { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: .28em .6em; margin-top: .65em; font-size: .66em; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }
.tg-intro-r .tg-intro-attrs { text-align: left; }
.tg-at-l { color: var(--cream-dim); }
.tg-at-v { font-variant-numeric: tabular-nums; color: var(--cream); text-align: right; }
.tg-at-b { height: .5em; border-radius: .25em; background: rgba(246, 239, 223, .1); overflow: hidden; }
.tg-at-b i { display: block; height: 100%; border-radius: .25em; background: linear-gradient(90deg, color-mix(in srgb, var(--pc) 70%, #000), var(--pc)); transform-origin: 0 50%; transform: scaleX(var(--v)); animation: tgBarIn 1s var(--e-out) both; animation-delay: calc(var(--d) + .5s + var(--k) * 70ms); }
.tg-intro-vs { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); animation: tgVs .8s var(--e-back) .5s both; }
.tg-intro-vs span { display: block; font-size: 2.6em; font-weight: 900; font-style: italic; letter-spacing: .04em; background: linear-gradient(180deg, #fff3c4, #d9b45a); -webkit-background-clip: text; background-clip: text; color: transparent; filter: drop-shadow(0 .06em .2em rgba(0, 0, 0, .6)); }

/* ================================================================ Linienkamera */
.tg-hawk { position: absolute; right: 2.4em; top: 50%; width: 19.5em; margin-top: -10.5em; padding: .85em .95em .9em; border-radius: 1em; display: none; }
.tg-hawk.is-on { display: block; animation: tgSlideL .6s var(--e-out) both; }
.tg-hawk.is-out { animation: tgSlideOutR .38s var(--e-in) forwards; }
.tg-hawk-head { display: flex; align-items: center; gap: .5em; font-size: .66em; font-weight: 850; letter-spacing: .22em; text-transform: uppercase; color: var(--cream-dim); margin-bottom: .7em; }
.tg-hawk-head .tg-ico { width: 1.5em; height: 1.5em; color: var(--gold); }
.tg-hawk-head em { margin-left: auto; font-style: normal; color: var(--gold-hi); letter-spacing: .12em; }
.tg-hawk-view { border-radius: .55em; overflow: hidden; box-shadow: inset 0 0 0 1px rgba(246, 239, 223, .12), 0 .3em .9em rgba(0, 0, 0, .3); }
.tg-hawk-view svg { display: block; width: 100%; height: auto; }
.tg-hk-lbl { font-size: 7.5px; font-weight: 800; letter-spacing: 1.4px; fill: rgba(255, 255, 255, .82); font-family: inherit; stroke: rgba(6, 38, 26, .55); stroke-width: 2.4px; paint-order: stroke; stroke-linejoin: round; }
.tg-hk-meas { stroke: #fff; stroke-width: 1.3; fill: none; opacity: 0; animation: tgFadeIn .4s 1.05s forwards; }
.tg-hk-gap { opacity: 0; animation: tgFadeIn .5s 1s forwards; }
.tg-hawk.is-v-in .tg-hk-gap { fill: rgba(71, 209, 140, .55); }
.tg-hawk.is-v-out .tg-hk-gap { fill: rgba(255, 92, 80, .55); }
.tg-hk-ball { animation: tgHkBall .9s var(--e-out) .25s both; }
.tg-hawk-verdict { display: flex; align-items: baseline; justify-content: space-between; margin-top: .55em; }
.tg-hk-v { font-size: 2.9em; font-weight: 900; font-style: italic; line-height: 1; letter-spacing: .02em; animation: tgVerdict .6s var(--e-back) .95s both; }
.tg-hawk.is-v-in .tg-hk-v { color: var(--ok); text-shadow: 0 0 .5em rgba(71, 209, 140, .55); }
.tg-hawk.is-v-out .tg-hk-v { color: #ff6b5e; text-shadow: 0 0 .5em rgba(255, 107, 94, .5); }
.tg-hk-d { font-size: 1.5em; font-weight: 850; font-variant-numeric: tabular-nums; animation: tgFadeIn .5s 1.1s both; }
.tg-hk-d small { font-size: .55em; font-weight: 700; color: var(--cream-dim); }
.tg-hawk-note { margin-top: .2em; font-size: .72em; font-weight: 600; color: var(--cream-dim); animation: tgFadeIn .5s 1.2s both; }

/* ================================================================ Seitenwechsel */
.tg-change { position: absolute; inset: 0; display: none; overflow: hidden; }
.tg-change.is-on { display: block; }
.tg-change-wipe { position: absolute; top: -10%; bottom: -10%; left: -25%; right: -25%; background: linear-gradient(100deg, #062a1b 0%, #0d4a31 40%, #0f5638 55%, #062a1b 100%); transform: translateX(-125%) skewX(-14deg); animation: tgWipe 2.7s var(--e-io) both; }
.tg-change-wipe::after { content: ''; position: absolute; inset: 0; background: repeating-linear-gradient(90deg, rgba(255, 255, 255, .035) 0 6vmin, rgba(255, 255, 255, 0) 6vmin 12vmin); }
.tg-change-edge { position: absolute; top: -10%; bottom: -10%; left: -25%; width: 1.2vmin; background: linear-gradient(180deg, #fbe7a6, #d9b45a); box-shadow: 0 0 2vmin rgba(243, 217, 138, .8); transform: translateX(-10vw) skewX(-14deg); animation: tgEdge 2.7s var(--e-io) both; }
.tg-change-edge-2 { width: .4vmin; animation-delay: .06s; opacity: .7; }
.tg-change:not(.is-cover) .tg-change-wipe { opacity: .9; top: 34%; bottom: 34%; }
.tg-change:not(.is-cover) .tg-change-edge { display: none; }
.tg-change-c { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: .3em; animation: tgChangeC 2.7s linear both; }
.tg-change-swap { display: flex; align-items: center; gap: 1.2em; margin-bottom: .5em; }
.tg-cs-p { width: 3.8em; height: 3.8em; border-radius: 50%; overflow: hidden; flex: none; box-shadow: 0 0 0 .18em var(--pc), 0 .4em 1em rgba(0, 0, 0, .45); }
.tg-cs-p svg { display: block; width: 100%; height: 100%; }
.tg-cs-a { animation: tgSwapA 1s var(--e-io) 1.05s both; }
.tg-cs-b { animation: tgSwapB 1s var(--e-io) 1.05s both; }
.tg-change-arrows { width: 2.8em; height: 2.8em; color: var(--gold-hi); }
.tg-ca { display: block; width: 100%; height: 100%; animation: tgSwap 1.1s var(--e-io) .95s both; }
.tg-ca .tg-ico { width: 100%; height: 100%; stroke-width: 1.5; }
.tg-change-t { font-size: 3.6em; font-weight: 900; font-style: italic; letter-spacing: .03em; text-transform: uppercase; background: linear-gradient(180deg, #fff 20%, #f3d98a); -webkit-background-clip: text; background-clip: text; color: transparent; filter: drop-shadow(0 .05em .12em rgba(0, 0, 0, .5)); }
.tg-change-s { font-size: .95em; font-weight: 750; letter-spacing: .3em; text-transform: uppercase; color: var(--cream-dim); }

/* ================================================================ Replay */
.tg-lb { position: absolute; left: 0; right: 0; height: 8.5vh; background: #000; transition: transform .55s var(--e-out); }
.tg-lb-t { top: 0; transform: translateY(-101%); }
.tg-lb-b { bottom: 0; transform: translateY(101%); }
.tg-ui.is-replay .tg-lb { transform: none; }
.tg-replay-badge { position: absolute; left: 2em; top: calc(8.5vh + 1.1em); display: flex; align-items: center; gap: .6em; padding: .5em 1em .5em .8em; border-radius: .6em; opacity: 0; transform: translateX(-1.5em); transition: opacity .35s, transform .5s var(--e-out); }
.tg-ui.is-replay .tg-replay-badge { opacity: 1; transform: none; }
.tg-replay-badge > .tg-ico { width: 1.5em; height: 1.5em; color: var(--gold-hi); }
.tg-ui.is-replay .tg-replay-badge > .tg-ico { animation: tgSpinBack 2.4s linear infinite; }
.tg-rec { width: .6em; height: .6em; border-radius: 50%; background: #ff4b3e; box-shadow: 0 0 .6em #ff4b3e; animation: tgPulse 1s ease-in-out infinite; }
.tg-replay-t { display: flex; flex-direction: column; line-height: 1.1; }
.tg-replay-t b { font-size: .95em; font-weight: 900; font-style: italic; letter-spacing: .16em; text-transform: uppercase; }
.tg-replay-t small { font-size: .62em; font-weight: 700; letter-spacing: .24em; text-transform: uppercase; color: var(--gold); }

/* ================================================================ Fade */
.tg-fade { position: absolute; inset: 0; background: #010604; opacity: 0; pointer-events: none; z-index: 60; }

/* ================================================================ Keyframes */
@keyframes tgFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes tgFadeOut { from { opacity: 1; } to { opacity: 0; } }
@keyframes tgRise { from { opacity: 0; transform: translateY(1.2em) scale(.96); } to { opacity: 1; transform: none; } }
@keyframes tgPop { from { opacity: 0; transform: translateY(1em) scale(.95); } to { opacity: 1; transform: none; } }
@keyframes tgSlideR { from { opacity: 0; transform: translateX(-2.5em); } to { opacity: 1; transform: none; } }
@keyframes tgSlideL { from { opacity: 0; transform: translateX(2.5em); } to { opacity: 1; transform: none; } }
@keyframes tgSlideOutL { to { opacity: 0; transform: translateY(-50%) translateX(-3em); } }
@keyframes tgSlideOutR { to { opacity: 0; transform: translateX(2.5em); } }
@keyframes tgItemIn { from { opacity: 0; transform: translateX(-1.4em); } to { opacity: 1; transform: none; } }
@keyframes tgShine { 0% { transform: translateX(-110%); } 45%, 100% { transform: translateX(110%); } }
@keyframes tgBeam { from { transform: rotate(18deg); } to { transform: rotate(-22deg); } }
@keyframes tgPulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.7); } }
@keyframes tgThrob { from { transform: scale(1); } to { transform: scale(1.08); } }
@keyframes tgFlagIn { from { transform: translateY(-105%); } to { transform: none; } }
@keyframes tgSpeedIn { from { opacity: 0; transform: translateX(-1.5em); } to { opacity: 1; transform: none; } }
@keyframes tgSpeedOut { to { opacity: 0; transform: translateX(-1em); } }
@keyframes tgBandIn { from { transform: skewX(-14deg) scaleX(0); opacity: .4; } to { transform: skewX(-14deg) scaleX(1); opacity: 1; } }
@keyframes tgEcho { from { transform: translate(-38%, -50%); opacity: 0; } 14% { opacity: .2; } 60% { opacity: .12; } to { transform: translate(-62%, -50%); opacity: 0; } }
@keyframes tgSweep { from { transform: translateX(-120%); } to { transform: translateX(360%); } }
@keyframes tgLineL { from { opacity: 0; transform: translateX(-30%) scaleX(.3); } to { opacity: 1; transform: none; } }
@keyframes tgLineR { from { opacity: 0; transform: translateX(30%) scaleX(.3); } to { opacity: 1; transform: none; } }
@keyframes tgLetter { 0% { opacity: 0; transform: translateY(.38em) skewX(-18deg) scale(1.25); } 60% { opacity: 1; } 100% { opacity: 1; transform: none; } }
@keyframes tgSubIn { from { opacity: 0; transform: translateY(.6em); } to { opacity: 1; transform: none; } }
@keyframes tgBannerOut { to { opacity: 0; transform: translateX(4em) skewX(-8deg); } }
@keyframes tgBurst { 0% { opacity: .9; transform: scale(.15); } 100% { opacity: 0; transform: scale(2.1); } }
@keyframes tgConfetti { 0% { opacity: 0; transform: translate(0, 0) rotate(0); } 8% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; transform: translate(var(--dx), calc(var(--dy) + 6em)) rotate(var(--r)); } }
@keyframes tgToastIn { from { opacity: 0; transform: translateY(-.9em) scale(.94); } to { opacity: 1; transform: none; } }
@keyframes tgToastOut { to { opacity: 0; transform: translateY(-.6em) scale(.96); } }
@keyframes tgRaysIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes tgSpin { to { rotate: 360deg; } }
@keyframes tgSpinBack { to { transform: rotate(-360deg); } }
@keyframes tgTrophy { 0% { opacity: 0; transform: translateY(3em) scale(.7); } 60% { opacity: 1; transform: translateY(-.3em) scale(1.04); } 100% { opacity: 1; transform: none; } }
@keyframes tgGlint { 0%, 70%, 100% { opacity: 0; transform: scale(.4) rotate(0); } 80% { opacity: 1; transform: scale(1) rotate(45deg); } }
@keyframes tgNameIn { from { opacity: 0; transform: translateY(.5em) scale(.92); } to { opacity: 1; transform: none; } }
@keyframes tgRowIn { from { opacity: 0; transform: translateX(1.2em); } to { opacity: 1; transform: none; } }
@keyframes tgBarIn { from { transform: scaleX(0); } }
@keyframes tgIntroTop { from { opacity: 0; transform: translate(-50%, -1.5em); } to { opacity: 1; transform: translateX(-50%); } }
@keyframes tgIntroL { from { opacity: 0; transform: translateX(-4em); } to { opacity: 1; transform: none; } }
@keyframes tgIntroR { from { opacity: 0; transform: translateX(4em); } to { opacity: 1; transform: none; } }
@keyframes tgIntroOutL { to { opacity: 0; transform: translateX(-3em); } }
@keyframes tgIntroOutR { to { opacity: 0; transform: translateX(3em); } }
@keyframes tgPortrait { from { opacity: 0; transform: scale(.6) rotate(-12deg); } to { opacity: 1; transform: none; } }
@keyframes tgVs { from { opacity: 0; transform: translate(-50%, -50%) scale(2.2); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
@keyframes tgHkBall { 0% { opacity: 0; transform: translateY(-46px) scaleY(1.5); } 55% { opacity: 1; transform: translateY(4px) scaleY(.9); } 100% { opacity: 1; transform: none; } }
@keyframes tgVerdict { from { opacity: 0; transform: scale(1.8); } to { opacity: 1; transform: none; } }
@keyframes tgWipe {
  0% { transform: translateX(-125%) skewX(-14deg); } 26% { transform: translateX(0) skewX(-14deg); }
  76% { transform: translateX(0) skewX(-14deg); } 100% { transform: translateX(125%) skewX(-14deg); }
}
@keyframes tgEdge {
  0% { transform: translateX(-10vw) skewX(-14deg); } 26% { transform: translateX(150vw) skewX(-14deg); }
  76% { transform: translateX(-10vw) skewX(-14deg); } 100% { transform: translateX(150vw) skewX(-14deg); }
}
@keyframes tgChangeC { 0%, 18% { opacity: 0; } 30%, 72% { opacity: 1; } 84%, 100% { opacity: 0; } }
@keyframes tgSwapA { 0% { transform: none; } 50% { transform: translate(4.5em, -1.5em) scale(.9); } 100% { transform: translateX(9em); } }
@keyframes tgSwapB { 0% { transform: none; } 50% { transform: translate(-4.5em, 1.5em) scale(.9); } 100% { transform: translateX(-9em); } }
@keyframes tgSwap { 0% { transform: rotate(0) scale(.6); opacity: 0; } 40% { opacity: 1; transform: scale(1); } 100% { transform: rotate(180deg) scale(1); opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .tg-ui *, .tg-ui *::before, .tg-ui *::after { animation-duration: 1ms !important; animation-delay: 0ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; }
}
`;

/** Stylesheet einmalig in das Dokument einfügen. */
export function injectStyles(doc = document) {
  if (doc.getElementById('tg-ui-style')) return;
  const st = doc.createElement('style');
  st.id = 'tg-ui-style';
  st.textContent = UI_CSS;
  (doc.head || doc.documentElement).appendChild(st);
}
