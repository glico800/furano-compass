/* ==========================================================
   富良野コンパス
   どこにいても富良野の方向がわかる。それ以外の方角はわからない。

   しくみ
   1. GPSで現在地を取る
   2. 現在地 → 富良野 の方角（方位角）を計算する
   3. 方位センサーでスマホが向いている方角を取る
   4. 2と3がだいたい同じなら「富良野」、違えば「富良野じゃない」

   ※ 位置情報と方位センサーは HTTPS でしか動かない（GitHub Pages ならOK）
   ※ PCで動作確認したいときは URL に ?debug を付ける → ←→キーで向きを変えられる
   ========================================================== */

'use strict';

// ---------- 設定 ----------

// 富良野の座標（富良野市役所あたり）
const FURANO = { lat: 43.3421, lon: 142.3832 };

// 「富良野を向いている」とみなす角度のブレ幅（±何度まで許すか）
// スマホの方位センサーはそこまで正確じゃないので、狭すぎると永遠に富良野にならない
const TOLERANCE_DEG = 10;

// 富良野からこの距離（km）以内なら「ここが富良野」扱い
// （富良野の中にいると方角を出しても意味がないので）
const HERE_KM = 5;

// 方位センサーが反応しないとみなすまでの時間（ミリ秒）
const SENSOR_TIMEOUT_MS = 3000;

// ---------- 状態 ----------

const state = {
  heading: null,        // スマホが向いている方角（0〜360、北=0、時計回り）
  furanoBearing: null,  // 現在地から見た富良野の方角（0〜360）
  isHere: false,        // 富良野の中にいるかどうか
  shownHeading: 0,      // 画面に表示中の角度（なめらかに動かすため、360を超えてもOK）
};

// ---------- 要素 ----------

const startScreen = document.getElementById('start-screen');
const compassScreen = document.getElementById('compass-screen');
const startButton = document.getElementById('start-button');
const readout = document.getElementById('readout');
const pointer = document.getElementById('pointer');
const dial = document.getElementById('dial');
const message = document.getElementById('message');

const isDebug = new URLSearchParams(location.search).has('debug');

// 文字盤の中の「富良野の印」グループ（buildDialで作る）
let furanoGroup = null;

// ==========================================================
// 文字盤（SVG）を作る
// ==========================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG要素を作るちょっとしたヘルパー */
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
}

function buildDial() {
  // 目盛り：iOSのコンパスと同じく2度ごとに1本、30度ごとに太い線
  // ただし数字や「N/E/S/W」は書かない（富良野以外の方角は知らなくていいので）
  for (let deg = 0; deg < 360; deg += 2) {
    const isMajor = deg % 30 === 0;
    const outer = 150;
    const inner = isMajor ? 128 : 136;
    // SVGの座標は「上が-Y」なので、北=上 になるように sin/cos を使い分ける
    const rad = (deg * Math.PI) / 180;
    dial.appendChild(svgEl('line', {
      x1: Math.sin(rad) * inner,
      y1: -Math.cos(rad) * inner,
      x2: Math.sin(rad) * outer,
      y2: -Math.cos(rad) * outer,
      class: isMajor ? 'tick major' : 'tick',
    }));
  }

  // 富良野の印：いったん「上（北）」に描いて、グループごと富良野の方角に回す
  furanoGroup = svgEl('g', { class: 'furano-group', display: 'none' });

  // iOSで北を示している赤い三角のポジションに、富良野を置く
  furanoGroup.appendChild(svgEl('path', {
    d: 'M 0 -126 L -7 -112 L 7 -112 Z',
    class: 'furano-mark',
  }));

  // iOSで「N / E / S / W」が書いてある4か所に、文字を置く
  // 北（＝富良野）だけ「こっちが富良野」、残りの東・南・西は全部「富良野じゃない」
  const labels = [
    { deg: 0, text: 'こっちが富良野', className: 'furano-label' },
    { deg: 90, text: '富良野じゃない', className: 'not-furano-label' },
    { deg: 180, text: '富良野じゃない', className: 'not-furano-label' },
    { deg: 270, text: '富良野じゃない', className: 'not-furano-label' },
  ];
  for (const { deg, text, className } of labels) {
    const label = svgEl('text', {
      x: 0,
      y: -172,
      transform: `rotate(${deg})`,
      class: className,
    });
    label.textContent = text;
    furanoGroup.appendChild(label);
  }

  dial.appendChild(furanoGroup);
}

// ==========================================================
// 計算まわり
// ==========================================================

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** 角度を 0〜360 に収める（-30 → 330 など） */
const normalize = (deg) => ((deg % 360) + 360) % 360;

/** 2つの角度の差を -180〜180 で返す（350と10の差は20、みたいに） */
const angleDiff = (a, b) => normalize(a - b + 180) - 180;

/**
 * 現在地 → 目的地 の方位角（北=0、時計回り）
 * 地球を球として計算する「大圏コース」の初期方位
 */
function calcBearing(from, to) {
  const φ1 = toRad(from.lat);
  const φ2 = toRad(to.lat);
  const Δλ = toRad(to.lon - from.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalize(toDeg(Math.atan2(y, x)));
}

/** 2点間の距離（km）。ハバーサイン公式 */
function calcDistanceKm(from, to) {
  const R = 6371; // 地球の半径
  const dφ = toRad(to.lat - from.lat);
  const dλ = toRad(to.lon - from.lon);
  const a = Math.sin(dφ / 2) ** 2
    + Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ==========================================================
// 位置情報（GPS）
// ==========================================================

function startGeolocation() {
  if (!('geolocation' in navigator)) {
    showMessage('geo', 'このブラウザでは位置情報が使えないみたい。');
    return;
  }

  // 現在地は画面に出さない。富良野の方角の計算にだけ使う
  navigator.geolocation.watchPosition(
    (pos) => {
      const here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      state.furanoBearing = calcBearing(here, FURANO);
      state.isHere = calcDistanceKm(here, FURANO) <= HERE_KM;

      // 富良野の印を、計算した方角に回して表示する
      furanoGroup.setAttribute('transform', `rotate(${state.furanoBearing})`);
      furanoGroup.setAttribute('display', state.isHere ? 'none' : 'inline');
      hideMessage('geo');
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        showMessage('geo', '位置情報が許可されていないので、富良野がどっちかわからない。<br>設定から位置情報を許可してね。');
      } else {
        showMessage('geo', '位置情報が取れなかった。電波のいいところで試してみて。');
      }
    },
    {
      enableHighAccuracy: false, // 方角を出すだけなので、ざっくりで十分（電池にやさしい）
      maximumAge: 60 * 1000,
      timeout: 15 * 1000,
    }
  );
}

// ==========================================================
// 方位センサー
// ==========================================================

/**
 * iOS 13以降は、ボタンを押した瞬間（ユーザー操作の中）に許可を求める必要がある。
 * Androidやそれ以外では requestPermission 自体が存在しないので、そのまま true を返す。
 */
async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent !== 'undefined'
    && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const result = await DeviceOrientationEvent.requestPermission();
      return result === 'granted';
    } catch (e) {
      return false;
    }
  }
  return true;
}

/** 画面の回転（横向きなど）の角度。基本は縦持ちの0 */
function getScreenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') {
    return screen.orientation.angle;
  }
  return window.orientation || 0; // 古いiOS用
}

function startOrientation() {
  let gotEvent = false;

  const onOrientation = (e) => {
    let compass = null;

    if (typeof e.webkitCompassHeading === 'number') {
      // iOS：webkitCompassHeading が「北=0、時計回り」の方角をそのままくれる
      compass = e.webkitCompassHeading;
    } else if (e.absolute && typeof e.alpha === 'number') {
      // Android：alpha は「反時計回り」なので 360 から引いて時計回りにする
      compass = 360 - e.alpha;
    }

    if (compass === null) return;

    gotEvent = true;
    state.heading = normalize(compass + getScreenAngle());
  };

  // Android Chrome は deviceorientationabsolute のほうが北基準の値をくれる
  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', onOrientation);
  } else {
    window.addEventListener('deviceorientation', onOrientation);
  }

  // しばらく待っても反応がなければ、センサーがない（PCなど）と判断
  setTimeout(() => {
    if (!gotEvent && !isDebug) {
      showMessage('sensor', 'このデバイスでは向きがわからないみたい。<br>スマホで開いてね。');
    }
  }, SENSOR_TIMEOUT_MS);
}

// ==========================================================
// デバッグ用（?debug のときだけ）：←→キーで向きを変える
// ==========================================================

function startDebugControls() {
  state.heading = 0;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') state.heading = normalize(state.heading - 5);
    if (e.key === 'ArrowRight') state.heading = normalize(state.heading + 5);
  });

  // 位置情報が使えない環境でも試せるように、仮の現在地（東京駅）で富良野の方角を出しておく
  // ※ ?debug&lat=..&lon=.. で場所を変えられる
  const params = new URLSearchParams(location.search);
  const here = {
    lat: Number(params.get('lat') ?? 35.6812),
    lon: Number(params.get('lon') ?? 139.7671),
  };
  state.furanoBearing = calcBearing(here, FURANO);
  state.isHere = calcDistanceKm(here, FURANO) <= HERE_KM;
  furanoGroup.setAttribute('transform', `rotate(${state.furanoBearing})`);
  furanoGroup.setAttribute('display', state.isHere ? 'none' : 'inline');
}

// ==========================================================
// 描画ループ
// ==========================================================

function render() {
  if (state.heading !== null) {
    // 文字盤をなめらかに回す。
    // 359°→1° のときに逆回りでぐるっと1周しないよう、「差分」だけ足していく
    const diff = angleDiff(state.heading, state.shownHeading);
    state.shownHeading += diff * 0.2; // 0.2 = 追従の速さ（1に近いほどキビキビ）

    // 向いている方向が上に来るように、文字盤は逆向きに回す
    dial.style.transform = `rotate(${-state.shownHeading}deg)`;
  }

  updateReadout();
  requestAnimationFrame(render);
}

/** 上の大きい文字を更新する */
function updateReadout() {
  let text;
  let isFurano = false;

  if (state.isHere) {
    // 富良野の中にいるなら、どっちを向いても富良野
    text = 'ここが富良野';
    isFurano = true;
  } else if (state.heading === null || state.furanoBearing === null) {
    // センサーかGPSの準備中
    text = '…';
  } else if (Math.abs(angleDiff(state.heading, state.furanoBearing)) <= TOLERANCE_DEG) {
    text = '富良野';
    isFurano = true;
  } else {
    text = '富良野じゃない';
  }

  // 毎フレーム書き換えると無駄なので、変わったときだけ
  if (readout.textContent !== text) {
    readout.textContent = text;
  }
  readout.classList.toggle('is-furano', isFurano);
  pointer.classList.toggle('is-furano', isFurano);
}

// ==========================================================
// メッセージ表示
// ==========================================================

// メッセージは出どころ（GPS / 方位センサー）ごとに持っておく。
// 位置情報が取れたときに、方位センサーのエラーまで消してしまわないように
const messages = { geo: null, sensor: null };

function showMessage(source, html) {
  messages[source] = html;
  updateMessage();
}

function hideMessage(source) {
  messages[source] = null;
  updateMessage();
}

/** 出ているメッセージを全部並べて表示する。1つもなければ隠す */
function updateMessage() {
  const list = Object.values(messages).filter(Boolean);
  message.innerHTML = list.join('<br><br>');
  message.hidden = list.length === 0;
}

// ==========================================================
// スタート
// ==========================================================

startButton.addEventListener('click', async () => {
  // ★ iOSの許可ダイアログは「クリックの処理の中」で一番最初に呼ばないと出ない
  const orientationOK = await requestOrientationPermission();

  // 画面を切り替え
  startScreen.hidden = true;
  compassScreen.hidden = false;

  if (isDebug) {
    startDebugControls();
  } else {
    if (orientationOK) {
      startOrientation();
    } else {
      showMessage('sensor', '方位センサーが許可されていないので、向きがわからない。<br>ページを再読み込みして、もう一度許可してね。');
    }
    startGeolocation();
  }

  requestAnimationFrame(render);
});

buildDial();
