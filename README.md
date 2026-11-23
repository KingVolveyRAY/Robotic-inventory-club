# RoboLab · Inventaris Klub Robotik

RoboLab adalah situs peminjaman peralatan klub robotik. Anggota bisa mencari alat, mengecek stok, dan mengajukan peminjaman. Pengurus mengelola inventaris, meninjau pengajuan, serta mencatat pengambilan dan pengembalian.

## Coba demo

Prasyaratnya Node.js 24 atau lebih baru dan npm.

```sh
npm ci
npm run demo
```

Buka http://127.0.0.1:3000. Pilih **Masuk → Akun demo** untuk mencoba sebagai anggota atau pengurus. Pengurus demo juga bisa masuk dengan nama pengguna `adminpeminjaman` dan kata sandi demo `Rakit-Robot-Bareng`. Kamu juga bisa mendaftarkan akun anggota baru. Demo memuat 30 jenis alat dan beberapa contoh peminjaman. Perubahan demo disimpan di `.data/demo.sqlite`. Gunakan `npm run dev` untuk memuat ulang server saat mengubah kode di folder `src`.

### Alur yang bisa dicoba

1. Dari katalog, buka alat yang tersedia, lalu ajukan pinjaman dengan tanggal ambil hari ini dan tanggal kembali yang diinginkan.
2. Masuk sebagai pengurus dan buka **Panel Pengurus → Menunggu**. Setujui pengajuan tersebut.
3. Di **Siap diambil**, catat pengambilan. Di **Dipinjam**, catat pengembalian. Stok tersedia akan bertambah kembali.
4. Di **Inventaris**, coba menambah alat, mengubah stok, atau menyembunyikan alat dari katalog.

Persetujuan langsung menahan stok sampai pengembalian atau pembatalan. Anggota bisa membatalkan sebelum alat diambil. Tanggal memakai kalender WIB. Pengambilan bisa diajukan hingga 30 hari ke depan dengan durasi maksimal 14 hari termasuk hari pengambilan.

Di **Pinjaman**, anggota punya dashboard jadwal pribadi, Kit Proyek, dan Galeri Rakitan. Pengajuan kit memakai stok komponen yang sama dengan katalog. Setelah pengembalian, anggota bisa menerbitkan cerita dan foto rakitan serta membagikan daftar alatnya.

Di **Panel Pengurus**, kartu **Dashboard Hari Ini** membuka antrean yang perlu ditangani. Checklist pengembalian menyimpan catatan kondisi dan menahan unit yang perlu diperbaiki sampai ditandai selesai di **Servis**. **Inventaris** menyediakan label QR per jenis alat untuk membuka daftar serah terima, dan **Kegiatan** membandingkan kebutuhan tim dengan stok siap dipinjam saat ini.

Gunakan **Panel Pengurus → Kegiatan** untuk menambahkan latihan, lomba, kegiatan, atau pengumuman. Isi tanggal, waktu WIB, dan tanggal akhir pengulangan untuk latihan mingguan. Agenda yang dipublikasikan muncul di **Pinjaman → Agenda klub** dan pengumuman tampil mulai tanggal terbitnya.

Tombol **Musik** membuka tiga instrumental orisinal dari aset lokal. Pemutar mengingat lagu, posisi, dan volume dalam tab yang sama.

## Jalankan untuk inventaris klub

1. Jalankan `npm ci` dari root repositori.
2. Salin `.env.example` ke `.env`. Isi `ROBOLAB_ADMIN_EMAIL` dengan email pengurus, dan `ROBOLAB_ADMIN_PASSWORD` dengan kata sandi minimal 12 karakter.
3. Jalankan `npm start`. Katalog dimulai kosong. Masuk dengan akun pengurus dan tambahkan alat dari menu **Inventaris**. Anggota membuat akun melalui halaman **Daftar**.

Mode klub memakai database terpisah di `.data/robolab.sqlite`. Gunakan `ROBOLAB_DATABASE_PATH` bila ingin menyimpannya di volume persisten tertentu. Simpan cadangan menggunakan mekanisme backup SQLite. Pengurus utama bisa masuk dengan `adminpeminjaman` atau email pengurus. Gunakan proses penggantian kata sandi di bawah untuk akun yang sudah tersimpan.

Secara bawaan server mendengarkan di `127.0.0.1:3000`. Gunakan `ROBOLAB_HOST` dan `PORT` jika perlu mengubah alamat. Untuk menjalankan mode klub di belakang HTTPS, aktifkan `ROBOLAB_SECURE_COOKIES=1` dan sesuaikan `ROBOLAB_PROXY_HOPS` dengan jumlah reverse proxy tepercaya. Endpoint `GET /healthz` memeriksa koneksi database.

## Pemeriksaan

```sh
npm test
```

Pengujian memakai database sementara dan mencakup pemisahan mode demo, hak akses, konsistensi stok, serta siklus pinjam dan kembali.

## Deploy di Vercel

Impor repositori di Vercel dengan preset **Express** dan runtime Node.js 24. Hubungkan database PostgreSQL yang dapat diakses lewat TLS, misalnya Neon. Tambahkan variabel berikut di **Settings → Environment Variables** sebelum deploy.

- `DATABASE_URL` berisi URL koneksi PostgreSQL. Gunakan database terpisah untuk Production dan Preview.
- `ROBOLAB_ADMIN_EMAIL` dan `ROBOLAB_ADMIN_PASSWORD` menyiapkan akun pengurus. Nama pengguna pengurus utama adalah `adminpeminjaman`. Gunakan kata sandi privat untuk Production.
- `ROBOLAB_SAMPLE_INVENTORY=1` mengisi 30 alat contoh pada database kosong. Katalog contoh lama mendapat 24 tambahan. Jumlah unit di mode ini adalah stok simulasi untuk review.

Hubungkan repositori lewat **Settings → Git** jika belum terhubung. Setelah menyimpan variabel di lingkungan **Production**, buka **Deployments → Create Deployment** dan masukkan branch `main`. Vercel akan membuat build baru menggunakan pengaturan terbaru.

Buka `/healthz` untuk memeriksa koneksi database dan buka halaman utama untuk melihat katalog. `npm run demo` tetap memakai SQLite lokal dan dua akun demo. Akun demo lokal tidak dibuat pada Vercel.

Untuk pratinjau publik katalog tanpa akun dan penyimpanan permanen, gunakan `ROBOLAB_PUBLIC_CATALOG=1`. Hapus opsi itu saat mengaktifkan peminjaman dengan PostgreSQL.

### Tambah paket alat ke inventaris klub

Buka **Panel Pengurus → Inventaris → Impor draf alat**. Paket menambahkan entri yang belum ada, lengkap dengan deskripsi dan gambar ilustrasi. Draf dimulai dengan stok 0 dan tersembunyi dari katalog. Edit alat untuk mencatat jumlah unit yang dimiliki klub dan menampilkannya ke anggota.

### Ganti kata sandi pengurus yang sudah ada

Di pengaturan **Environment Variables** untuk **Production** di Vercel, isi `ROBOLAB_ADMIN_EMAIL` dengan email akun pengurus yang sudah terdaftar. Isi `ROBOLAB_ADMIN_PASSWORD` dengan frasa sandi baru dan `ROBOLAB_ADMIN_PASSWORD_REVISION` dengan `1` untuk penggantian pertama. Naikkan nomor revisi untuk penggantian berikutnya. Secara lokal, gunakan variabel yang sama di `.env`.

Buat deployment baru dari `main` atau jalankan ulang server lokal, lalu buka **Masuk** dengan `adminpeminjaman` dan frasa sandi baru. Peminjaman tetap terhubung ke akun yang sama. Sesi pengurus sebelumnya berakhir saat kata sandi diganti. Revisi yang sama hanya diterapkan sekali.
