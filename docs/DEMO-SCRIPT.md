# Demo script — three minutes

The brief sets the demo at three minutes. This is the shot list, timed, with
the exact words and the exact click for each beat. Nothing in it needs a result
that does not exist.

**Assets:** the live site `https://quittance-inky.vercel.app`, the phone with
the release APK installed, and a terminal for the verifier.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:20 | Landing hero, then **Who this is for** | "Adaeze runs a twelve-member savings circle in Onitsha market. Collection day costs her two hours of cross-checking screenshots, and twice a year a dispute ends a friendship." |
| 0:20–0:50 | **See it work** — press *Play the walkthrough* and stop on step 4, *Android kills the app* | "Ngozi pays. Her wallet approves it. Then Android kills the app before the result comes back. The money moved and the app never found out. Mobile Wallet Adapter 2.0 made that the only mandatory signing path." |
| 0:50–1:20 | Steps 5–7: *She reopens it → It asks the chain → It already knows* | "A durable nonce account is anchored to every contribution before the wallet opens. On reopen the app reads that one account — not the phone — and knows." |
| 1:20–1:50 | **How it resolves** diagram | "Three outcomes, not two. When a nonce transaction fails, the runtime rolls back the transfer and still advances the nonce — so advanced means *processed*, not *paid*. Most designs get this wrong." |
| 1:50–2:20 | **/proof** — scroll the five PASS rows | "Five experiments against devnet. Ten identical rebroadcasts, one transfer. A consumed nonce is refused by the validator itself — the strongest invariant isn't ours." |
| 2:20–2:45 | The **phone**: open the installed app, show the circle; then **Prove it yourself** on the site with a connected devnet wallet | "This is the standalone release app on a real Android phone, and this is the same mechanism running live with my own wallet against the cluster." |
| 2:45–3:00 | Terminal: the verifier command, then the repo | "Anyone can recompute every verdict from chain state, with no app and no key. Quittance: nobody gets charged twice." |

## Optional beat — E8 on the device (adds ~25 s)

If you want the gate on camera: on the phone, **long-press the circle name →
Run E8 → approve in Solflare**. The screen lists each step as PASS or FAIL and
ends with a verdict. Record it only if it completes; the result is whatever the
wallet actually did.

## Recording notes

- Record the web at 1440×900 and the phone with `adb exec-out screenrecord`
  or the device's own recorder.
- Keep the walkthrough on step 4 for a full second: it is the frame the product
  exists for.
- Do not narrate a campaign number. None exists until `pnpm campaign` has run.
