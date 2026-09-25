# MOTION.md — the table's animation design

Status: **implemented** (all three tiers of §4). The motion tokens live in
`packages/client/src/styles/tokens.css`; the fan geometry in `base.css`; the felt,
trick, bubble, declaration and celebration work in `table.css`; the React side in
`screens/Table.tsx`, `screens/table/TableOverlays.tsx`, `components/Confetti.tsx`
and `countUp.ts`. §1 is kept as the record of what was wrong and why each choice
was made — read it before changing any of this.

It covers only the **Table** screen (the felt, the hand, the sheets, the overlays)
— that is where 95 % of a session is spent and where all the feel lives.

---

## 1. What is wrong today

Audited by playing the offline learn scenarios at an iPhone-14 viewport
(`/learn/tutorial`, `/learn/endgame`) and reading every `@keyframes` in
`base.css` + `table.css`.

**What already works and must survive the rewrite**

- The 1.5 s gold "heartbeat" shared by `.opp--turn`, `.thand--turn`, `.tsheet--turn` —
  one rhythm across three surfaces is exactly right.
- `trick-in`: each played card flies in from its player's edge, with per-seat rotation.
- The four-colour deck, the felt palette, the inline-SVG cards. Graphically the
  product is already coherent; the gap is motion, not colour.
- `prefers-reduced-motion` is honoured everywhere. Non-negotiable going forward.
- The procedural sound layer (`sound.ts`) — every cue we add motion for already
  has audio. Motion and sound must be re-synced, not re-invented.

**Defects, in order of how much they cost the player**

| # | Defect | Where |
| --- | --- | --- |
| 1 | **Your own speech bubble is orphaned.** `.bubble--me { bottom: 16% }` parks it in empty felt, ~250 px above your hand, tail pointing at nothing. It reads as a stray tooltip, not as *you* speaking. | `table.css:382` |
| 2 | **The won trick lands off-screen.** `.trick--to-p0` glides a fixed `122px` down regardless of felt height; on a phone the stack ends up clipped by `.felt{overflow:hidden}` and buried under the hand footer, and `.trick__label` ("X voitti tikin") sits *behind* the cards, unreadable. | `table.css:485-518` |
| 3 | **No deal animation.** A new deal materialises nine cards instantly. The single most ritual moment in a card game does not exist. | `Table.tsx` `HandFan` |
| 4 | **Cards teleport out of your hand.** Tap → spinner → snapshot → the card is simply gone and the fan re-flows in one frame. `trick-in` fakes an arrival that never had a departure. | `store.ts` update path |
| 5 | **The hand is a row, not a fan.** Flat negative margins, no arc, no rotation, no lift. `--raised` is a bare `translateY`. | `base.css:206-243` |
| 6 | **Opponent hands read as a barcode.** 14 px card backs at `-9px` overlap; the count jumps 9 → 6 with no motion at all. | `table.css:274-286` |
| 7 | **Bubbles pop out of existence.** `bubble-in` is opacity-only over 160 ms and dismissal is a bare React unmount — no exit, no transform origin at the tail. | `table.css:297-397` |
| 8 | **No sense of progress.** Won tricks slide away and vanish; nothing accumulates anywhere on the felt. | — |
| 9 | **The biggest reveal in the game is a chip flash.** Declaring a marriage / setting trump gets a 760 ms top-bar blink and a gold bubble. | `table.css:73-94` |
| 10 | **Scores appear fully-formed.** The deal-scored overlay springs in with final numbers already printed. | `TableOverlays.tsx` |
| 11 | **The turn pulse is paint-heavy.** Three surfaces animate `background` **and** `box-shadow` on an infinite 1.5 s loop — continuous repaint on a mid-range phone. | `table.css:210,668,768` |
| 12 | **Timings are ad hoc.** 160 / 180 / 200 / 220 / 420 / 520 / 650 / 700 / 760 / 1500 / 1800 / 2800 ms with five different easings. There is no motion language, so nothing feels like one physical world. | everywhere |

---

## 2. The motion language

One physical model, four rules:

1. **Everything that concerns a player originates from that player's seat anchor.**
   Bubbles, emotes, played cards, captured tricks. Nothing floats unattached.
2. **Objects (cards) move with weight; UI (sheets, chips, bubbles) moves with speed.**
   Cards get `--ease-felt` and 300–520 ms; UI gets `--ease-out` and 180 ms.
3. **Every state change gets an entrance *and* an exit.** No unmount-pops.
4. **Only `transform`, `opacity` and `filter` animate.** Never `background`,
   `box-shadow`, `width` or `margin` on a loop.

### 2.1 Tokens

Add to `tokens.css`:

```css
:root {
  /* Durations — five steps, nothing in between. */
  --dur-1: 90ms;   /* micro: press ack */
  --dur-2: 180ms;  /* UI: bubble, chip, sheet */
  --dur-3: 300ms;  /* object: a card in flight */
  --dur-4: 520ms;  /* stage: the trick sweeping to its winner */
  --dur-5: 900ms;  /* moment: a celebration beat */

  /* Curves */
  --ease-out:    cubic-bezier(0.22, 1, 0.36, 1);     /* arriving */
  --ease-in:     cubic-bezier(0.55, 0, 1, 0.45);     /* leaving */
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);  /* pops, with overshoot */
  --ease-felt:   cubic-bezier(0.36, 0, 0.3, 1);      /* heavy slide across cloth */

  /* Stagger unit for dealt cards / score rows. */
  --stagger: 55ms;
}
```

### 2.2 Seat anchors

One set of custom properties, set per felt slot, consumed by *everything*
transient. Percentages so they scale with the felt instead of the current fixed
pixels:

```css
.felt { --anchor-x: 50%; --anchor-y: 50%; }
.slot-0 { --anchor-x: 50%;  --anchor-y: 96%; }  /* me, at the hand */
.slot-1 { --anchor-x: 8%;   --anchor-y: 30%; }  /* left */
.slot-2 { --anchor-x: 50%;  --anchor-y: 6%;  }  /* top / across */
.slot-3 { --anchor-x: 92%;  --anchor-y: 30%; }  /* right */
```

Fixes defect #2 by construction: the trick glides to a **percentage** of the
felt, so it can never leave it.

---

## 3. Layer by layer

### 3.1 Speech bubbles (defects #1, #7)

- `.bubble--me` moves to the **bottom-centre of the felt**, `bottom: var(--space-2)`,
  tail down — i.e. hugging the top edge of the sheet/hand, visually attached to
  your own cards. This is the change the brief asked for.
- The felt bottom-centre becomes a **rail** (`display:flex; flex-direction:column;
  align-items:center`) shared by your bubble, the turn countdown and the talon
  strip, so those three can never overlap. Today they are three independently
  absolutely-positioned elements competing for the same 60 px.
- `transform-origin` moves to the tail, so a bubble grows *out of* its speaker.
- Entry + exit in **one animation list**, no React change needed — the store
  already dismisses at `BUBBLE_MS`:

  ```css
  .bubble {
    animation:
      bubble-in  var(--dur-2) var(--ease-spring),
      bubble-out 220ms var(--ease-in) 4780ms both;   /* BUBBLE_MS − 220ms */
  }
  @keyframes bubble-in  { from { opacity: 0; transform: scale(0.72) translateY(6px); } }
  @keyframes bubble-out { to   { opacity: 0; transform: scale(0.9)  translateY(-4px); } }
  ```

- The trump bubble additionally emits a one-shot gold ring (§3.5).

### 3.2 The hand (defects #4, #5)

**Position the fan with `transform`, not `margin`.** This is the enabling change:
margins cannot be transitioned across a reflow, transforms can. Each card gets its
slot as `--fx` / `--fy` / `--fr` (px, px, deg), computed in JS from the fan's
**measured** width by `screens/table/fanLayout.ts`, with
`transition: transform var(--dur-2) var(--ease-out)`.

**Every card stays visible and tappable** (the fan's usability contract):

- The fan spreads to use the width it has, up to a natural overlap
  (`MAX_STEP` = 0.62 × card width), minus a small side margin so tilted corners
  never touch the screen edge.
- Suit groups get a gap (0.45 × step) while that still leaves a comfortable strip.
- No card's visible strip ever drops below `MIN_STEP` (0.4 × card width, ≥ 26 px) —
  that clears the corner index and a thumb. When one row can't honour it (13–14
  cards on a 320–390 px phone), the hand **splits into two rows** (`.hand--rows`),
  on a suit boundary near the middle when there is one; the back row peeks out
  0.44 × card height above the front row, index band fully visible.
- The arc (rotation up to 9°, middle rising 7 % of a card) is measured from the
  outer cards, so the fan never dips below the footer.
- Screen-fixed controls (reaction picker, "I'm back") float above the felt's
  bottom edge (`--felt-inset-bottom`, published by `Table.tsx`), never over the fan.

What transforms buy, for free:

- **A real fan** — arc, rotation, the outer cards sitting lower.
- **Gap-closing**: play a card, the neighbours glide into the space instead of
  snapping.
- **Parting**: same-row neighbours of the raised card shift ±6 px, the "peek" of
  a real hand.

On top:

- **Touch-and-slide picking.** Pointer input is resolved on `.hand`, not per
  button: the card under the finger (the browser's own hit-test, so exactly the
  visible face) lifts as a *preview* (`--dur-1`, 14 % of a card) and is the one
  chosen on release; a touch between cards snaps to the nearest one; sliding off
  the hand cancels. Sliding *onto* the raised card never plays it — only a press
  that starts on it does. Buttons use `aria-disabled` (a `disabled` button would
  swallow the slide) and their `click` serves the keyboard only.
- **Raise** becomes `translateY(-30%) scale(1.04) rotate(0deg)` — the card
  *straightens out of the fan* as it lifts. It keeps its stacking order, so it
  never covers a neighbour's index. In two-row mode a front-row card lifts only
  10 % (it would hide the back row's indices) and glows gold instead.
- **Illegal cards** keep the brightness/saturate filter (never opacity — overlapping
  cards bleed through) and additionally sit 4 px lower, so legality is readable
  as *shape*, not only as colour.
- **Departure**: the played card animates out along the vector to the trick centre
  (`--dur-3`, `--ease-in`, scale to the trick card's size) while the fan closes.
  The existing `trick-in` then continues the same motion on the felt — one
  continuous flight instead of two disconnected ones.

### 3.3 The deal (defect #3)

On `dealStarted`, keyed by `dealIndex` so it replays every deal:

- Nine cards fly from the **dealer's** seat anchor to your fan, `--stagger` apart,
  `scale(0.8) rotate(-8deg)` → resting fan position, `--dur-3` `--ease-felt`.
- Opponent fans deal in the same rhythm as card backs.
- Total ≈ 900 ms for a round-robin deal. It is the "sit down at the table" beat
  the game currently lacks.

Pure CSS: `animation-delay: calc(var(--i) * var(--stagger))` on the same
`--i` the fan geometry already needs.

### 3.4 The trick (defects #2, #6, #8)

Replace the current single 520 ms slide (fired after a 720 ms delay) with **five
beats**, ~1.1 s total:

| Beat | What | Duration |
| --- | --- | --- |
| 1 | The final card lands | `--dur-3` `--ease-out` |
| 2 | Hold — the beat where you actually read the trick | 120 ms |
| 3 | Winning card lifts (`scale(1.1)`) and takes a gold rim | 260 ms |
| 4 | The four cards **gather** into a square stack (offsets and rotations → 0) | 220 ms |
| 5 | The stack flies to the winner's anchor, shrinking to `0.5`, and lands on their trick pile | `--dur-4` `--ease-felt` |

`.trick__label` moves **above** the trick box and stays there through the whole
sequence, so "Kalle voitti tikin" is legible instead of buried.

**Trick piles — new.** A small stack of card backs beside each seat that grows as
they win tricks (`CardStack` already renders exactly this). It gives the felt
something that *accumulates*: the cheapest, strongest progress hook available,
and it makes beat 5 land somewhere meaningful instead of into the void.

**Opponent fans** get the same transform-based geometry as your hand, so a card
leaving an opponent's hand slides toward the trick centre and the remaining backs
close up — instead of the count silently ticking 9 → 6.

### 3.5 The moments (defects #9, #10)

**Trump / marriage declaration.** The dramatic peak of Huutopussi, currently a
760 ms chip blink. Redesign, ~1.4 s:

1. A gold radial wash sweeps across the whole felt in the trump suit's colour.
2. The suit glyph blooms centre-felt: `scale(0.4) blur(8px)` → `scale(1.15)` →
   `scale(1)` sharp, then fades.
3. The gold bubble springs in on the declaring seat.
4. The top-bar trump chip settles into its resting glow (keep the existing chip).

Stretch: fly the K + Q out of the hand face-up to the felt centre, then back.

**Deal scored.** Backdrop `blur(3px)` in over `--dur-2`; panel springs; breakdown
rows stagger in `--stagger` apart; **numbers count up** from 0 over 600 ms
(a small `useCountUp` hook, reduced-motion → final value immediately); the delta
row flashes green/red.

**Läpäri / match win.** Confetti becomes a **cannon**: pieces launch upward from
the bottom edge with varied size and shape, then fall — instead of the current
uniform top-down rain. The läpäri word gains a single expanding shockwave ring.

**Turn arrival.** Today arriving on your turn and waiting on your turn look
identical. Add a one-shot gold sweep left→right along the hand footer's top edge
(`--dur-3`) on arrival, which then settles into the existing heartbeat.

**Turn countdown.** Replace the bottom-centre numeric pill with a gold bar that
**drains** along the top edge of the hand footer, plus the number moved bottom-right
out of the trick's landing zone. A draining bar communicates urgency far better
than a digit, and frees the felt's bottom-centre rail for §3.1.

### 3.6 Performance (defect #11)

- Turn pulse: give each surface a static gold-glow pseudo-element and animate
  **only its `opacity`**. Same look, no repaint.
- `will-change: transform` on the trick group and flying cards **while animating only**.
- `contain: layout paint` on `.opp`.
- Cap concurrent infinite animations at one per surface.

### 3.7 Reduced motion

Every new animation needs a `prefers-reduced-motion` branch that keeps the
**information** and drops the travel: the winner rim stays, the trick pile still
increments, the count-up jumps to its final value, the deal appears without
flight. Same discipline the current stylesheet already shows.

---

## 4. Build order (as shipped)

**Tier 1 — fix what is broken** (low risk, immediately visible)
1. Motion tokens + seat anchors (§2) — everything else depends on them.
2. Bubble anchoring and spring in/out (§3.1) — the brief's explicit complaint.
3. Trick resolve: felt-relative glide, readable label, five beats (§3.4 beats 1–5, no piles yet).
4. Turn-arrival sweep + drain-bar countdown (§3.5).
5. Turn-pulse repaint fix (§3.6).

**Tier 2 — the juice** (structural; enables the rest)
6. Transform-based hand fan: arc, parting, straightening raise (§3.2).
7. Card departure animation, hand + opponents (§3.2, §3.4).
8. The deal (§3.3).
9. Trick piles (§3.4).

**Tier 3 — the moments**
10. Trump / marriage reveal (§3.5).
11. Score count-up, staggered rows, backdrop blur (§3.5).
12. Confetti cannon + läpäri shockwave (§3.5).

Tier 1 is a stylesheet-and-tokens change plus small `Table.tsx` edits. Tier 2
touches `HandFan` and `OpponentPanel` geometry. Tier 3 adds one component
(`DeclarationFlash`) and one hook (`useCountUp`).

Nothing here needs a new dependency — the client stays on hand-written CSS, which
the PWA's strict CSP and the zero-asset sound engine already commit us to.
