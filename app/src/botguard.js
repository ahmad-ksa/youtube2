// BotGuard / WebPO token service. Derived from LuanRT/googlevideo examples (MIT).
import { buildURL, GOOG_API_KEY } from 'bgutils-js/utils';
import { BotGuardClient, parseChallengeData } from 'bgutils-js/botguard';
import { WebPoMinter, createColdStartToken } from 'bgutils-js/webpo';

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const HEADERS = {
  'content-type': 'application/json+protobuf',
  'x-goog-api-key': GOOG_API_KEY,
  'x-user-agent': 'grpc-web-javascript/0.1'
};

class Botguard {
  client = null;
  minter = null;
  challenge = null;
  pending = null;

  init() {
    if (!this.pending) {
      this.pending = this.#setup().catch((e) => {
        console.warn('[BotGuard] init failed', e);
      }).finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  async #setup() {
    const res = await fetch(buildURL('Create', true), { method: 'POST', headers: HEADERS, body: JSON.stringify([REQUEST_KEY]) });
    this.challenge = parseChallengeData(await res.json());
    const js = this.challenge?.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (!js) throw new Error('no interpreter');
    if (!document.getElementById(this.challenge.interpreterHash)) {
      const s = document.createElement('script');
      s.id = this.challenge.interpreterHash;
      s.textContent = js;
      document.head.appendChild(s);
    }
    this.client = await BotGuardClient.create({
      globalObject: globalThis,
      globalName: this.challenge.globalName,
      program: this.challenge.program
    });
    const webPoSignalOutput = [];
    const snapshot = await this.client.snapshot({ webPoSignalOutput });
    const itRes = await fetch(buildURL('GenerateIT', true), { method: 'POST', headers: HEADERS, body: JSON.stringify([REQUEST_KEY, snapshot]) });
    const integrityToken = (await itRes.json())[0];
    if (!integrityToken) throw new Error('no integrity token');
    this.minter = await WebPoMinter.create({ integrityToken }, webPoSignalOutput);
  }

  get ready() { return !!this.minter; }

  coldStart(binding) { return createColdStartToken(binding); }

  async mint(binding) {
    const t = performance.now();
    if (!this.ready) await this.init();
    if (!this.minter) return undefined;
    try {
      const tok = await this.minter.mintAsWebsafeString(binding);
      console.info('[time] PoToken', Math.round(performance.now() - t) + ' ms');
      return tok;
    } catch (e) {
      console.warn('[BotGuard] mint failed, reinit', e);
      this.minter = null;
      await this.init();
      return this.minter ? this.minter.mintAsWebsafeString(binding) : undefined;
    }
  }
}

export const botguard = new Botguard();
