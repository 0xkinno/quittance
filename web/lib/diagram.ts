/**
 * The resolution flow, as text.
 *
 * Typeset in Geist Mono on sunk paper rather than shipped as an image: it
 * stays selectable, searchable, legible at any zoom, and readable by a screen
 * reader. An image of a diagram is a diagram nobody can copy a value out of.
 */
export const ASCII_DIAGRAM = `            INTENT                 EFFECT                  TRUTH
          (the phone)            (the wallet)            (the chain)

   allocate nonce ──┐
   read value N ────┤
   build tx ────────┤
   hash message ────┤
   WRITE + FSYNC ───┘──── signAndSendTransactions ────▶ nonce advances
                              │                              │
                        [ process killed ]                   │
                              │                              │
                              ▼                              ▼
                        no signature                   one account holds
                        no bytes                       the entire answer
                              │                              │
                              └──────── read nonce ──────────┘
                                             │
                        unchanged ───────────┴─────────── advanced
                             │                                │
                         NOT_SENT                   match? ───┴─── no match
                       rebroadcast                     │            │
                      (runtime drops                SETTLED      AMBIGUOUS
                       duplicates)                 / REJECTED    escalate`;
