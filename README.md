# RoboLab · Inventaris Klub Robotik

RoboLab adalah situs peminjaman peralatan klub robotik. Anggota bisa mencari alat, mengecek stok, dan mengajukan peminjaman. Pengurus mengelola inventaris, meninjau pengajuan, serta mencatat pengambilan dan pengembalian.

## Coba demo

Prasyaratnya Node.js 24 atau lebih baru dan npm.

```sh
npm ci
npm run demo
```

Buka http://127.0.0.1:3000. Pilih **Masuk → Akun demo** untuk mencoba sebagai anggota atau pengurus. Kamu juga bisa mendaftarkan akun anggota baru. Demo memuat enam jenis alat dan beberapa contoh peminjaman. Perubahan demo disimpan di `.data/demo.sqlite`. Gunakan `npm run dev` untuk memuat ulang server saat mengubah kode di folder `src`.

### Alur yang bisa dicoba

1. Dari katalog, buka alat yang tersedia, lalu ajukan pinjaman dengan tanggal ambil hari ini dan tanggal kembali yang diinginkan.
2. Masuk sebagai pengurus dan buka **Panel Pengurus → Menunggu**. Setujui pengajuan tersebut.
3. Di **Siap diambil**, catat pengambilan. Di **Dipinjam**, catat pengembalian. Stok tersedia akan bertambah kembali.
4. Di **Inventaris**, coba menambah alat, mengubah stok, atau menyembunyikan alat dari katalog.

Persetujuan langsung menahan stok sampai pengembalian atau pembatalan. Anggota bisa membatalkan sebelum alat diambil. Tanggal memakai kalender WIB. Pengambilan bisa diajukan hingga 30 hari ke depan dengan durasi maksimal 14 hari termasuk hari pengambilan.

## Jalankan untuk inventaris klub

1. Jalankan `npm ci` dari root repositori.
2. Salin `.env.example` ke `.env`. Isi `ROBOLAB_ADMIN_EMAIL` dengan email pengurus, dan `ROBOLAB_ADMIN_PASSWORD` dengan kata sandi minimal 12 karakter.
3. Jalankan `npm start`. Katalog dimulai kosong. Masuk dengan akun pengurus dan tambahkan alat dari menu **Inventaris**. Anggota membuat akun melalui halaman **Daftar**.

Mode klub memakai database terpisah di `.data/robolab.sqlite`. Gunakan `ROBOLAB_DATABASE_PATH` bila ingin menyimpannya di volume persisten tertentu. Simpan cadangan menggunakan mekanisme backup SQLite. Variabel akun pengurus hanya dipakai saat membuat akun baru. Perubahan variabel kata sandi tidak mengganti kata sandi akun yang sudah tersimpan.

Secara bawaan server mendengarkan di `127.0.0.1:3000`. Gunakan `ROBOLAB_HOST` dan `PORT` jika perlu mengubah alamat. Untuk menjalankan mode klub di belakang HTTPS, aktifkan `ROBOLAB_SECURE_COOKIES=1` dan sesuaikan `ROBOLAB_PROXY_HOPS` dengan jumlah reverse proxy tepercaya. Endpoint `GET /healthz` memeriksa koneksi database.

## Pemeriksaan

```sh
npm test
```

Pengujian memakai database sementara dan mencakup pemisahan mode demo, hak akses, konsistensi stok, serta siklus pinjam dan kembali.
