/**
 * Entry point.
 *
 * `react-native-get-random-values` must be imported before anything that
 * touches @solana/web3.js: the Hermes runtime has no `crypto.getRandomValues`,
 * and web3.js reaches for it while generating keypairs and signing. Importing
 * it late produces a crash that looks like a web3.js bug and is not.
 */

import 'react-native-get-random-values';
import { Buffer } from 'buffer';
import { registerRootComponent } from 'expo';

// web3.js assumes a Node `Buffer` global. React Native does not provide one.
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer;
}

import App from './App';

registerRootComponent(App);
