# R2NETTE brand application

Derived from the supplied brand board. Nothing here is invented, and nothing
from the board is copied blindly.

## Palette (from the board's swatch row)

```
--navy    #0A2547   backgrounds, ledger, sticky bar, footer
--deep    #0B4DA2   primary brand blue
--blue    #1F8FE0   mid ramp
--electric#3BA9F5   highlights, bubble tint
--teal    #12A79B   action gradient start
--green   #3FAE49   action gradient end
--lime    #8BC63F   accents, live dot
--gold    #FFC627   SAVINGS ONLY
```

**Gold is reserved for money the customer saves.** Discount lines, the savings
pill, BEST VALUE, and the welcome-offer amount. It appears nowhere else, so
savings are unmissable.

## Logo

`web/public/assets/brand/` — full lockup, white variant, and a square app
icon, redrawn as SVG from the board mark (orb + house + broom + bubbles). The
header uses the white lockup with a wordmark fallback if the file is missing.

## Motifs

- **Bubbles** — atmospheric only, in the hero and on card corners. Never
  behind form fields or price lines.
- **Montréal skyline** — a low-contrast SVG band in the hero and footer.
- **Sheen** — one slow highlight sweep across the welcome-offer card.

## What was deliberately NOT copied

The board is marketing art; some of it would be a claim we cannot support.

| On the board | Why it is not in the product |
|---|---|
| 514-444-8578 | The seeded business number is **(514) 825-2825**. The app shows the number in the database, never a number from an image. |
| "Insured & Bonded" | A legal claim. Not shown until the owner confirms coverage. |
| "Eco-Friendly Products" | A product claim tied to what is actually loaded in the van. |
| "5-Star Service" | The rating is computed from published reviews; with none, the hero shows nothing. |
| "UP TO $20 OFF" | The **amount is read from the promotion engine** via `/api/v1/promotions/public`. It currently renders $20 because that is the seeded Deep welcome offer. Change or disable the promotion and the hero follows. |

That last one matters most: the hero cannot advertise an offer the pricing
engine would not honour.

## Assets still needed from the owner

- `web/public/assets/hero.jpg` — a real photo. The gradient hero is a
  placeholder; the photo layer fades in only if the file loads.
- Team and interior photography for the service cards.

## Motion system

Tokens rather than ad-hoc values, so timing stays consistent:

```
--spring cubic-bezier(.34,1.56,.64,1)   anything the customer causes
--smooth cubic-bezier(.4,0,.2,1)        ambient / colour transitions
--t-fast 140ms  --t-base 240ms  --t-slow 420ms
```

Elevation is a four-step ramp (`--e1`…`--e4`) with navy-tinted shadows, not
grey — grey shadows on a blue brand read as dirt.

**The price is the emotional centre**, so it is the most animated thing on the
page. Line items cascade in at 45 ms intervals, discount lines land with a
gold spring, and the total *rolls* from its previous value to the new one in
both the ledger and the sticky bar. Nothing about a price ever snaps.

Buttons lift 1px on hover, compress to 0.975 on press, and carry a ripple that
originates from the tap. Selection cards scale their checkmark in on a spring.
Slots stagger in at 22 ms.

`prefers-reduced-motion` collapses every duration to 0.01 ms and removes all
hover translation, but keeps colour and state changes fully legible — the
interface stays usable rather than becoming static and ambiguous.

## Loading and empty states

Slots load behind a shimmer skeleton that occupies the exact final layout, so
nothing jumps when real times arrive. An empty day gets an illustrated state
with a "call me" action rather than a dead sentence.

## Layout bugs found by screenshot review

- **Horizontal overflow on every step with a full-bleed rail.** Grid items
  default to `min-width:auto`, so the day rail's negative margins forced the
  whole column wider than the viewport — headings and the Continue button were
  cut off. Fixed with `.grid>*{min-width:0}`. The overflow guards alone had
  only hidden the symptom.
- **Toasts covered the primary action.** Moved to the top of the screen; the
  bottom belongs to the price and the Continue button.
- **BEST VALUE badge clipped**, because `<button>` clips overflow. The badge
  now sits inside the card.
- **Back button was invisible**, white on white, because `#nav` is a sibling
  of `.step` and never matched the scoped rule.
