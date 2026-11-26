#!/usr/bin/env python3
"""Standalone SQLCipher 4.9.0 decryptor and DaemonService key recovery tool.

Decrypts Huawei Health's local hihealth_003.db (SQLCipher 4: AES-256-CBC,
page_size=4096, reserve=80 [16B IV + 64B HMAC-SHA512], PBKDF2-HMAC-SHA512)
using Ubuntu's built-in OpenSSL libcrypto.so.3 via ctypes.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import hmac
import os
import sqlite3
import struct
import sys
from pathlib import Path

PAGE_SIZE = 4096
SALT_SIZE = 16
IV_SIZE = 16
HMAC_SIZE = 64
RESERVE_SIZE = IV_SIZE + HMAC_SIZE  # 80
SQLITE_HEADER = b"SQLite format 3\x00"
LIBSQLCIPHER_MASK_PTR_OFF = 0x4F9048
UNTAG_MASK = 0x00FFFFFFFFFFFFFF


def _load_libcrypto() -> ctypes.CDLL:
    for name in ("libcrypto.so.3", "libcrypto.so.1.1", "libcrypto.so"):
        try:
            lib = ctypes.CDLL(name)
            lib.EVP_CIPHER_CTX_new.restype = ctypes.c_void_p
            lib.EVP_aes_256_cbc.restype = ctypes.c_void_p
            lib.EVP_DecryptInit_ex.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_char_p,
                ctypes.c_char_p,
            ]
            lib.EVP_CIPHER_CTX_set_padding.argtypes = [ctypes.c_void_p, ctypes.c_int]
            lib.EVP_DecryptUpdate.argtypes = [
                ctypes.c_void_p,
                ctypes.c_char_p,
                ctypes.POINTER(ctypes.c_int),
                ctypes.c_char_p,
                ctypes.c_int,
            ]
            lib.EVP_CIPHER_CTX_free.argtypes = [ctypes.c_void_p]
            return lib
        except OSError:
            continue
    raise RuntimeError("Could not load OpenSSL libcrypto shared library")


def is_plain_sqlite(db_path: str | Path) -> bool:
    with open(db_path, "rb") as f:
        return f.read(16) == SQLITE_HEADER


def derive_hmac_key(raw_key: bytes, salt: bytes) -> bytes:
    hmac_salt = bytes(b ^ 0x3A for b in salt)
    return hashlib.pbkdf2_hmac("sha512", raw_key, hmac_salt, 2, 32)


def verify_page_hmac(page: bytes, pgno: int, hmac_key: bytes) -> bool:
    start = SALT_SIZE if pgno == 1 else 0
    mac_area_end = PAGE_SIZE - HMAC_SIZE
    mac = hmac.new(
        hmac_key,
        page[start:mac_area_end] + struct.pack("<I", pgno),
        hashlib.sha512,
    ).digest()
    return hmac.compare_digest(mac, page[mac_area_end:PAGE_SIZE])


def verify_page1_hmac(
    db_path: str | Path,
    raw_key: bytes,
    hmac_key: bytes | None = None,
) -> bool:
    with open(db_path, "rb") as f:
        page1 = f.read(PAGE_SIZE)
    if len(page1) < PAGE_SIZE:
        return False
    if page1[:16] == SQLITE_HEADER:
        return False
    if hmac_key is None:
        hmac_key = derive_hmac_key(raw_key, page1[:SALT_SIZE])
    return verify_page_hmac(page1, 1, hmac_key)


def decrypt_sqlcipher4(
    src_path: str | Path,
    dst_path: str | Path,
    raw_key: bytes,
    hmac_key: bytes | None = None,
    verify_all_hmac: bool = False,
) -> int:
    """Decrypt a SQLCipher 4 database to a plain SQLite file and verify integrity."""
    src = Path(src_path)
    dst = Path(dst_path)

    with open(src, "rb") as f:
        page1 = f.read(PAGE_SIZE)
    if len(page1) < PAGE_SIZE:
        raise ValueError(f"Source database shorter than 1 page: {src}")

    if hmac_key is None:
        hmac_key = derive_hmac_key(raw_key, page1[:SALT_SIZE])
    elif hmac_key != derive_hmac_key(raw_key, page1[:SALT_SIZE]):
        # Re-derive if database salt changed while raw key stayed identical, or reject if invalid.
        if not verify_page_hmac(page1, 1, hmac_key):
            hmac_key = derive_hmac_key(raw_key, page1[:SALT_SIZE])

    if not verify_page_hmac(page1, 1, hmac_key):
        raise ValueError("SQLCipher Page 1 HMAC-SHA512 verification failed (wrong key or corrupt DB)")

    lib = _load_libcrypto()
    cipher = lib.EVP_aes_256_cbc()
    ctx = lib.EVP_CIPHER_CTX_new()
    if not ctx:
        raise RuntimeError("EVP_CIPHER_CTX_new failed")

    out_buf = ctypes.create_string_buffer(PAGE_SIZE)
    outl = ctypes.c_int(0)
    zeros_reserve = b"\x00" * RESERVE_SIZE
    data_end = PAGE_SIZE - RESERVE_SIZE

    pgno = 0
    try:
        with open(src, "rb") as fin, open(dst, "wb") as fout:
            while True:
                pg = fin.read(PAGE_SIZE)
                if not pg:
                    break
                if len(pg) < PAGE_SIZE:
                    raise ValueError(f"Truncated page {pgno + 1}: {len(pg)} bytes")
                pgno += 1
                if verify_all_hmac and pgno > 1 and not verify_page_hmac(pg, pgno, hmac_key):
                    raise ValueError(f"HMAC verification failed on page {pgno}")

                iv = pg[data_end : data_end + IV_SIZE]
                if lib.EVP_DecryptInit_ex(ctx, cipher, None, raw_key, iv) != 1:
                    raise RuntimeError(f"EVP_DecryptInit_ex failed on page {pgno}")
                lib.EVP_CIPHER_CTX_set_padding(ctx, 0)

                ct_start = SALT_SIZE if pgno == 1 else 0
                ct_len = data_end - ct_start
                if lib.EVP_DecryptUpdate(ctx, out_buf, ctypes.byref(outl), pg[ct_start:data_end], ct_len) != 1:
                    raise RuntimeError(f"EVP_DecryptUpdate failed on page {pgno}")

                if pgno == 1:
                    fout.write(SQLITE_HEADER)
                fout.write(out_buf.raw[:ct_len])
                fout.write(zeros_reserve)
    finally:
        lib.EVP_CIPHER_CTX_free(ctx)

    con = sqlite3.connect(f"file:{dst}?mode=ro", uri=True)
    try:
        res = con.execute("PRAGMA quick_check;").fetchone()
        if not res or res[0] != "ok":
            raise RuntimeError(f"Decrypted SQLite quick_check failed: {res}")
    finally:
        con.close()

    return pgno


def _find_pid(cmdline_exact: str) -> int | None:
    target = cmdline_exact.encode("utf-8")
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/cmdline", "rb") as f:
                cmd = f.read().rstrip(b"\x00")
            if cmd == target:
                return int(name)
        except OSError:
            continue
    return None


def _parse_maps(pid: int) -> tuple[int | None, list[tuple[int, int]], list[tuple[int, int]]]:
    lib_base: int | None = None
    heap_regions: list[tuple[int, int]] = []
    lib_rw_regions: list[tuple[int, int]] = []

    with open(f"/proc/{pid}/maps", "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()

    i = 0
    while i < len(lines):
        line = lines[i]
        parts = line.split()
        if len(parts) < 2:
            i += 1
            continue
        s_str, e_str = parts[0].split("-")
        s, e = int(s_str, 16), int(e_str, 16)
        perms = parts[1]
        name = parts[5] if len(parts) > 5 else ""

        if "libsqlcipher.so" in name:
            if lib_base is None:
                lib_base = s
            if perms.startswith("rw"):
                lib_rw_regions.append((s, e))
                j = i + 1
                prev_end = e
                while j < len(lines):
                    p2 = lines[j].split()
                    if len(p2) < 2:
                        break
                    s2, e2 = [int(x, 16) for x in p2[0].split("-")]
                    if s2 == prev_end and p2[1].startswith("rw"):
                        lib_rw_regions.append((s2, e2))
                        prev_end = e2
                        j += 1
                    else:
                        break

        if perms.startswith("rw") and (e - s) <= 256 * 1024 * 1024:
            if "libc_malloc" in name or "scudo" in name or name == "":
                heap_regions.append((s, e))

        i += 1

    return lib_base, heap_regions, lib_rw_regions


def extract_key_from_daemon_mem(
    db_path: str | Path,
    process_name: str = "com.huawei.health:DaemonService",
) -> tuple[str, str]:
    """Recover the 32-byte raw AES key and HMAC key from DaemonService memory."""
    with open(db_path, "rb") as f:
        page1 = f.read(PAGE_SIZE)
    if len(page1) < PAGE_SIZE:
        raise ValueError(f"Database too small: {db_path}")
    salt = page1[:SALT_SIZE]
    hmac_salt = bytes(b ^ 0x3A for b in salt)

    pid = _find_pid(process_name)
    if pid is None:
        raise RuntimeError(f"Process '{process_name}' is not running; open Huawei Health once and retry")

    lib_base, heap_regions, lib_rw_regions = _parse_maps(pid)
    if lib_base is None or not lib_rw_regions:
        raise RuntimeError(f"Could not find libsqlcipher.so in /proc/{pid}/maps")

    with open(f"/proc/{pid}/mem", "rb", 0) as mem:
        salt_addrs: list[int] = []
        for s, e in heap_regions:
            try:
                mem.seek(s)
                buf = mem.read(e - s)
            except OSError:
                continue
            idx = buf.find(salt)
            while idx != -1:
                salt_addrs.append(s + idx)
                idx = buf.find(salt, idx + 1)

        if not salt_addrs:
            raise RuntimeError(f"Database salt not found in {process_name} memory (is DB open?)")

        masked_pairs: list[tuple[bytes, bytes]] = []
        for saddr in salt_addrs:
            pat6 = struct.pack("<Q", saddr)[:6]
            for s, e in heap_regions:
                try:
                    mem.seek(s)
                    buf = mem.read(e - s)
                except OSError:
                    continue
                idx = buf.find(pat6)
                while idx != -1:
                    if idx % 8 == 0 and idx + 40 <= len(buf):
                        rctx = struct.unpack_from("<Q", buf, idx + 32)[0] & UNTAG_MASK
                        if 0x1000000000 < rctx < 0x800000000000:
                            try:
                                mem.seek(rctx)
                                rc = mem.read(32)
                                _, kp, hp, _ = struct.unpack("<QQQQ", rc)
                                kp &= UNTAG_MASK
                                hp &= UNTAG_MASK
                                if 0x1000000000 < kp < 0x800000000000 and 0x1000000000 < hp < 0x800000000000:
                                    mem.seek(kp)
                                    mk1 = mem.read(32)
                                    mem.seek(hp)
                                    mk2 = mem.read(32)
                                    masked_pairs.append((mk1, mk2))
                            except OSError:
                                pass
                    idx = buf.find(pat6, idx + 8)

        if not masked_pairs:
            raise RuntimeError("Could not locate SQLCipher codec_ctx / read_ctx key buffers in memory")

        def _try_mask(mask: bytes) -> tuple[str, str] | None:
            if len(mask) != 32:
                return None
            for mk1, mk2 in masked_pairs:
                rk = bytes(a ^ b for a, b in zip(mk1, mask))
                hk = bytes(a ^ b for a, b in zip(mk2, mask))
                if hashlib.pbkdf2_hmac("sha512", rk, hmac_salt, 2, 32) == hk:
                    if verify_page_hmac(page1, 1, hk):
                        return rk.hex(), hk.hex()
            return None

        # Fast path: known libsqlcipher.so BSS pointer offset
        try:
            mem.seek(lib_base + LIBSQLCIPHER_MASK_PTR_OFF)
            ptr = struct.unpack("<Q", mem.read(8))[0] & UNTAG_MASK
            if 0x1000000000 < ptr < 0x800000000000:
                mem.seek(ptr)
                found = _try_mask(mem.read(32))
                if found:
                    return found
        except OSError:
            pass

        # Dynamic fallback: scan pointers inside libsqlcipher.so rw-p + [anon:.bss]
        for rs, re_end in lib_rw_regions:
            try:
                mem.seek(rs)
                rw_data = mem.read(re_end - rs)
            except OSError:
                continue
            for off in range(0, len(rw_data) - 8, 8):
                ptr = struct.unpack_from("<Q", rw_data, off)[0] & UNTAG_MASK
                if 0x1000000000 < ptr < 0x800000000000:
                    try:
                        mem.seek(ptr)
                        buf = mem.read(128)
                        for b_off in range(0, len(buf) - 32 + 1, 8):
                            found = _try_mask(buf[b_off : b_off + 32])
                            if found:
                                return found
                    except OSError:
                        continue

    raise RuntimeError("Failed to unmask SQLCipher key from DaemonService memory")


def main() -> int:
    parser = argparse.ArgumentParser(description="Decrypt Huawei Health SQLCipher 4 database")
    parser.add_argument("--src", required=True, help="Encrypted hihealth_003.db path")
    parser.add_argument("--dst", required=True, help="Output plaintext SQLite path")
    parser.add_argument("--key-hex", default="", help="32-byte raw AES key hex (64 chars)")
    parser.add_argument("--hmac-key-hex", default="", help="Optional 32-byte HMAC key hex")
    parser.add_argument("--recover-key", action="store_true", help="Recover key from DaemonService memory if needed")
    parser.add_argument("--verify-all-hmac", action="store_true", help="Verify HMAC-SHA512 on every page")
    args = parser.parse_args()

    raw_key = bytes.fromhex(args.key_hex) if args.key_hex else b""
    hmac_key = bytes.fromhex(args.hmac_key_hex) if args.hmac_key_hex else None

    if not raw_key or not verify_page1_hmac(args.src, raw_key, hmac_key):
        if not args.recover_key:
            print("ERROR: Key missing or Page 1 HMAC check failed (pass --recover-key to auto-recover)", file=sys.stderr)
            return 2
        rk_hex, hk_hex = extract_key_from_daemon_mem(args.src)
        raw_key = bytes.fromhex(rk_hex)
        hmac_key = bytes.fromhex(hk_hex)
        print(f"Recovered key={rk_hex} hmac_key={hk_hex}")

    pages = decrypt_sqlcipher4(args.src, args.dst, raw_key, hmac_key, verify_all_hmac=args.verify_all_hmac)
    print(f"Decrypted {pages} pages -> {args.dst} (quick_check=ok)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
