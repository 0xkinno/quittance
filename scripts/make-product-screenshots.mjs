// One-off: produce four equal-size product screenshots for the README,
// cropped (cover fit, centered) to the exact pixel size of the existing
// In-flight / Resolved ledger captures, so a 2x2 grid lines up perfectly.
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sharp = require(path.resolve('web/node_modules/sharp'));

const SRC = 'docs/screenshots';
const WIDTH = 680;
const HEIGHT = 624;

const PAPER = { r: 0xea, g: 0xeb, b: 0xe6, alpha: 1 };

const shots = [
  { src: 'recovering.png', out: 'product-1-in-flight.png' },
  { src: 'resolve.png', out: 'product-2-resolved.png' },
  { src: 'circle.png', out: 'product-3-the-circle.png' },
];

for (const shot of shots) {
  await sharp(path.join(SRC, shot.src))
    .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'top' })
    .png()
    .toFile(path.join(SRC, shot.out));
  console.log(`wrote ${shot.out}`);
}

// The fourth shot ("the part that breaks") comes from the full judge-demo
// section, which is desktop-wide with a nav bar and headline above the phone
// mockup — cropping it the same way as the others would either slice into
// the phone or drag in that surrounding chrome. Instead, crop tight to just
// the phone mockup, then letterbox (not stretch or cut) it onto the site's
// own paper colour so the fourth cell matches the other three in size
// without distorting or losing any of the phone's content.
const phone = await sharp(path.join(SRC, 'demo-killed.png'))
  .extract({ left: 117, top: 380, width: 350, height: 740 })
  .resize(WIDTH, HEIGHT, { fit: 'inside' })
  .toBuffer();

await sharp({
  create: { width: WIDTH, height: HEIGHT, channels: 4, background: PAPER },
})
  .composite([{ input: phone, gravity: 'center' }])
  .png()
  .toFile(path.join(SRC, 'product-4-killed.png'));
console.log('wrote product-4-killed.png');
