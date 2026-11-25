# 富良野コンパス

どこにいても富良野の方向がわかるコンパス。富良野以外の方角はわからない。

## 公開先（GitHub Pages）

https://glico800.github.io/furano-compass/

`main` ブランチの `(root)` をそのまま公開している。push すれば数分で反映される。
ユーザー名やリポジトリ名を変える場合は、`index.html` のOGPの絶対URL（3か所）も直すこと。

ビルド不要。HTTPSじゃないと位置情報・方位センサーが動かないので、ローカル確認はPCの `?debug` で。

## PCでの動作確認

`index.html?debug` で開くと、センサーなしで試せる。

- ←→ キー：向きを変える
- 仮の現在地は東京駅。`?debug&lat=43.34&lon=142.38` のように場所を変えられる

## 調整できる値（main.js の先頭）

| 定数 | 意味 | 初期値 |
|---|---|---|
| `FURANO` | 富良野の座標 | 富良野市役所あたり |
| `TOLERANCE_DEG` | 富良野とみなす角度のブレ幅（±） | 10 |
| `HERE_KM` | この距離以内なら「ここが富良野」 | 5 |

## ファイル

- `index.html` / `style.css` / `main.js`
- `ogp.png`（1200×630）/ `apple-touch-icon.png` / `favicon.svg` / `ramen.svg`
