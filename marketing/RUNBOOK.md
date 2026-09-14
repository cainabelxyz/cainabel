# RUNBOOK — launch CAIN & ABEL ($CABEL)

**T-0: Selasa, 16 September 2026 · 16:00 UTC (23:00 WIB)**
Domain: cainabel.xyz (Hostinger) · X/TG: @cainabelxyz · Chain: Robinhood Chain (4663)

Tidak ada backend. Situs statis + kontrak. Semua perintah dijalankan dari folder proyek ini.

---

## H-2 → H-1 (14–15 Sep): persiapan

1. **Hosting.** Upload isi folder `web/` ke Hostinger (root domain cainabel.xyz).
   Set halaman default `index.html`. Cek: `https://cainabel.xyz` menampilkan gerbang
   CAIN/ABEL, countdown jalan, `field.html` & `workbench.html` hidup, favicon muncul.
2. **Repo publik.** Buat repo GitHub (mis. `cainabelxyz/cainabel`), push seluruh proyek
   KECUALI `node_modules`. Kredibilitas "check it yourself" bergantung pada ini.
   Lalu isi `web/config.js` → `links.github`, upload ulang.
3. **Wallet.**
   - Wallet deploy (BUKAN vault MROBINHOOD): isi ETH di Robinhood Chain.
     Perkiraan gas deploy: gate table ~1,17 jt + Field ~1,66 jt gas. Dengan margin,
     0.001–0.005 ETH lebih dari cukup; lebihkan untuk step awal (~300 rb gas/ronde).
   - Vault MROBINHOOD: siapkan wallet + ETH untuk launch pons (fee 0.0005 ETH)
     dan dev buy (lihat H-0 langkah 1).
4. **Gladi resik di testnet (46630).**
   ```bash
   npm run silicon && npm run evm     # semua check harus PASS
   PRIVATE_KEY=0x... node scripts/deploy.js --testnet --with-test-token
   ```
   Lalu buka workbench lokal (`npm run serve` → python http.server), connect wallet
   ke testnet, `createMatch()`, step beberapa ronde, `claimPot()`. Seluruh loop harus
   jalan sebelum H-0.
5. **Konten X.** Jadwalkan/teaskan sesuai `marketing/x-launch-thread.md` (T-2 & T-1 teaser).

## H-0 (16 Sep): urutan eksekusi

**~15:30 UTC — launch token di pons via MROBINHOOD**
1. Buka MROBINHOOD → launch:
   - Name: `CAIN & ABEL` · Ticker: `CABEL`
   - Logo: `https://cainabel.xyz/assets/logo.png`
   - Description: *Two real 8-bit processors fight to the death in shared memory,
     inside a contract. Pick a brother. Keep his clock. Split the offering.
     cainabel.xyz*
   - Socials: website `https://cainabel.xyz`, X `@cainabelxyz`, TG `t.me/cainabelxyz`
   - Dev buy (bundled, snipe-tax exempt): saran 3–5% supply — sebagian untuk reserve
     Field, sebagian dipegang. Creator tax: 0 (biar bersih; fee split pons sudah ada).
2. Catat alamat token $CABEL dari hasil launch → `CABEL_TOKEN`.

**~15:40 UTC — deploy kontrak**
```bash
EMISSION_PER_ROUND=10 POT_PER_ROUND=5 \
CABEL_TOKEN=0x... PRIVATE_KEY=0x... node scripts/deploy.js
```
> Emission bersifat PERMANEN. Dengan reserve 30 jt CABEL: 30jt / (10+5) = 2 jt ronde
> terdanai. Naikkan/turunkan sesuai ukuran reserve yang kamu transfer.

**~15:45 UTC — isi reserve & match #1**
1. Transfer $CABEL dari wallet dev ke alamat Field (mis. 60–70% dari dev buy).
2. `web/config.js`: pastikan alamat terisi (deploy.js otomatis), isi `links.trade`
   dengan URL pair pons, upload ulang folder `web/` ke Hostinger.
3. Buka `cainabel.xyz/workbench.html` → connect wallet → `createMatch()`
   (default DWARF vs HUNTER). Step 10–20 ronde biar ada yang hidup saat orang datang.

**16:00 UTC — go public**
1. Post pinned + launch thread (file `x-launch-thread.md`), pin.
2. Announce di Telegram, sematkan CA + link.

## Pasca-launch (hari 1–3)
- Live-tweet match #1 setiap ada verdict (screenshot workbench + link explorer).
- Tantangan komunitas: "warrior terbaik minggu ini" — pemenang di-feature + kamu
  sponsori rondenya.
- Jaga clock: kalau tidak ada keeper, step sendiri beberapa ronde tiap beberapa jam
  supaya feed on-chain tidak diam.

## Angka yang boleh diklaim (semua terukur, jangan dilebihkan)
- 2 × 1.277 gerbang NAND, 88 flip-flop per die, RAM bersama 512 byte.
- 528.384 vektor uji, 0 gagal; 5 lapis verifikasi; EVM vs model: identik per blok.
- Gas: ~297 rb/ronde (dua die) pada batch — ~149 rb per cycle, terukur di EVM.
- Seluruh state pertandingan = tepat 256 bit = 1 slot storage.
- Deploy silicon 1,17 jt gas; kontrak Field 1,66 jt.

## Peringatan
- Kontrak tanpa owner & tanpa mint — tidak bisa diubah setelah deploy. Testnet dulu.
- Jangan pernah taruh PRIVATE_KEY di file/repo. Ekspor via env var sesaat sebelum pakai.
- Jangan menyebut atau menyerang proyek lain di konten publik — semua klaim
  berdiri di atas angka kita sendiri yang terukur.
