#define HWH_NO_MAIN
#include "hwh_keyrecover.c"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void hex_to_bytes(const char *hex, uint8_t *out, size_t len) {
    for (size_t i = 0; i < len; i++) {
        unsigned int v = 0;
        assert(sscanf(hex + i * 2, "%2x", &v) == 1);
        out[i] = (uint8_t)v;
    }
}

static void test_sha512_nist_vectors(void) {
    uint8_t digest[64];
    uint8_t expected[64];

    sha512((const uint8_t *)"", 0, digest);
    hex_to_bytes(
        "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce"
        "47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e",
        expected, 64);
    assert(memcmp(digest, expected, 64) == 0);

    sha512((const uint8_t *)"abc", 3, digest);
    hex_to_bytes(
        "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a"
        "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
        expected, 64);
    assert(memcmp(digest, expected, 64) == 0);
    printf("PASS: test_sha512_nist_vectors\n");
}

static void test_derive_hmac_key_vector(void) {
    uint8_t key[32];
    uint8_t salt[16];
    for (size_t i = 0; i < 32; i++) key[i] = (uint8_t)i;
    for (size_t i = 0; i < 16; i++) salt[i] = (uint8_t)i;

    uint8_t actual[32];
    derive_hmac_key(key, salt, actual);

    uint8_t expected[32];
    hex_to_bytes("601364baed0dde5a2d291ede302ae7e0540a85b57a281a0d19c344b7d4f382ce", expected, 32);
    assert(memcmp(actual, expected, 32) == 0);
    printf("PASS: test_derive_hmac_key_vector\n");
}

static void test_verify_page1_hmac(void) {
    uint8_t key[32];
    for (size_t i = 0; i < 32; i++) key[i] = (uint8_t)(0xA5U ^ (i * 7U));

    uint8_t page1[HWH_PAGE_SIZE];
    for (size_t i = 0; i < HWH_PAGE_SIZE - HWH_HMAC_SIZE; i++) {
        page1[i] = (uint8_t)((i * 13U + 5U) & 0xFFU);
    }

    uint8_t hmac_key[32];
    derive_hmac_key(key, page1, hmac_key);

    uint8_t msg[HWH_PAGE_SIZE - HWH_SALT_SIZE - HWH_HMAC_SIZE + 4];
    size_t body_len = HWH_PAGE_SIZE - HWH_SALT_SIZE - HWH_HMAC_SIZE;
    memcpy(msg, page1 + HWH_SALT_SIZE, body_len);
    msg[body_len + 0] = 1;
    msg[body_len + 1] = 0;
    msg[body_len + 2] = 0;
    msg[body_len + 3] = 0;
    hmac_sha512(hmac_key, 32, msg, sizeof(msg), page1 + HWH_PAGE_SIZE - HWH_HMAC_SIZE);

    assert(verify_page1_hmac(page1, hmac_key) == 1);

    uint8_t wrong_hk[32];
    memset(wrong_hk, 0, sizeof(wrong_hk));
    assert(verify_page1_hmac(page1, wrong_hk) == 0);

    page1[100] ^= 0x01;
    assert(verify_page1_hmac(page1, hmac_key) == 0);
    printf("PASS: test_verify_page1_hmac\n");
}

static void test_parse_maps_stream(void) {
    const char *sample =
        "5000000000-5000010000 r--p 00000000 00:00 0                              [anon:scudo:primary]\n"
        "5000010000-5000050000 rw-p 00000000 00:00 0                              [anon:scudo:primary]\n"
        "5000050000-5000090000 rw-p 00000000 00:00 0\n"
        "5000090000-50000a0000 ---p 00000000 00:00 0\n"
        "7100000000-7100400000 r--p 00000000 fd:01 1234                           /data/app/lib/arm64/libsqlcipher.so\n"
        "7100400000-71004f0000 r-xp 00400000 fd:01 1234                           /data/app/lib/arm64/libsqlcipher.so\n"
        "71004f0000-71004fa000 rw-p 004f0000 fd:01 1234                           /data/app/lib/arm64/libsqlcipher.so\n"
        "71004fa000-7100508000 rw-p 00000000 00:00 0                              [anon:.bss]\n"
        "7100508000-7100510000 r--p 00000000 00:00 0                              [anon:.bss]\n"
        "7200000000-7208000000 rw-p 00000000 00:00 0                              [anon:libc_malloc]\n"
        "7300000000-7320000000 rw-p 00000000 00:00 0                              [anon:libc_malloc]\n";

    FILE *f = fmemopen((void *)sample, strlen(sample), "r");
    assert(f != NULL);
    MapsInfo info;
    assert(parse_maps_stream(f, &info) == 0);
    fclose(f);

    assert(info.lib_base == 0x7100000000ULL);
    assert(info.lib_rw_regions.count == 2);
    assert(info.lib_rw_regions.items[0].start == 0x71004f0000ULL);
    assert(info.lib_rw_regions.items[0].end == 0x71004fa000ULL);
    assert(info.lib_rw_regions.items[1].start == 0x71004fa000ULL);
    assert(info.lib_rw_regions.items[1].end == 0x7100508000ULL);

    /* Scudo rw-p, anon rw-p, and libc_malloc rw-p (excluding .bss because it has name "[anon:.bss]" and isn't scudo/libc_malloc/empty) */
    assert(info.heap_regions.count == 3);
    assert(info.heap_regions.items[0].start == 0x5000010000ULL);
    assert(info.heap_regions.items[1].start == 0x5000050000ULL);
    assert(info.heap_regions.items[2].start == 0x7200000000ULL);

    maps_info_free(&info);
    printf("PASS: test_parse_maps_stream\n");
}

typedef struct {
    uint64_t salt_ptr;
    uint64_t pad1;
    uint64_t pad2;
    uint64_t pad3;
    uint64_t rctx_ptr;
} FakeCodecCtx;

static void test_recover_key_from_self_mem(void) {
    /* Build known key, mask, salt, and valid Page 1 HMAC */
    uint8_t raw_key[HWH_KEY_SIZE];
    uint8_t mask[HWH_KEY_SIZE];
    for (size_t i = 0; i < HWH_KEY_SIZE; i++) {
        raw_key[i] = (uint8_t)(0x21U + i * 3U);
        mask[i] = (uint8_t)(0x5CU ^ (i * 11U));
    }

    uint8_t page1[HWH_PAGE_SIZE];
    for (size_t i = 0; i < HWH_PAGE_SIZE - HWH_HMAC_SIZE; i++) {
        page1[i] = (uint8_t)((i * 29U + 3U) & 0xFFU);
    }
    uint8_t hmac_key[HWH_KEY_SIZE];
    derive_hmac_key(raw_key, page1, hmac_key);

    uint8_t msg[HWH_PAGE_SIZE - HWH_SALT_SIZE - HWH_HMAC_SIZE + 4];
    size_t body_len = HWH_PAGE_SIZE - HWH_SALT_SIZE - HWH_HMAC_SIZE;
    memcpy(msg, page1 + HWH_SALT_SIZE, body_len);
    msg[body_len + 0] = 1;
    msg[body_len + 1] = 0;
    msg[body_len + 2] = 0;
    msg[body_len + 3] = 0;
    hmac_sha512(hmac_key, 32, msg, sizeof(msg), page1 + HWH_PAGE_SIZE - HWH_HMAC_SIZE);

    /* Allocate real process buffers simulating DaemonService heap + libsqlcipher.so BSS */
    uint8_t *heap_buf = (uint8_t *)calloc(1, 4096);
    assert(heap_buf != NULL);
    uint8_t *salt_buf = heap_buf + 64;
    memcpy(salt_buf, page1, HWH_SALT_SIZE);

    uint8_t *mk1_buf = heap_buf + 256;
    uint8_t *mk2_buf = heap_buf + 320;
    for (size_t i = 0; i < HWH_KEY_SIZE; i++) {
        mk1_buf[i] = (uint8_t)(raw_key[i] ^ mask[i]);
        mk2_buf[i] = (uint8_t)(hmac_key[i] ^ mask[i]);
    }

    uint64_t *rc_buf = (uint64_t *)(heap_buf + 512);
    rc_buf[0] = 0;
    rc_buf[1] = 0xb400000000000000ULL | (uint64_t)(uintptr_t)mk1_buf;
    rc_buf[2] = 0xb400000000000000ULL | (uint64_t)(uintptr_t)mk2_buf;
    rc_buf[3] = 0;

    FakeCodecCtx *ctx_buf = (FakeCodecCtx *)(heap_buf + 1024);
    ctx_buf->salt_ptr = 0xb400000000000000ULL | (uint64_t)(uintptr_t)salt_buf;
    ctx_buf->rctx_ptr = 0xb400000000000000ULL | (uint64_t)(uintptr_t)rc_buf;

    /* Mask container with 16B header before the 32B mask (tests b_off != 0 in dynamic fallback too) */
    uint8_t *mask_holder = (uint8_t *)calloc(1, 128);
    assert(mask_holder != NULL);
    memcpy(mask_holder + 16, mask, HWH_KEY_SIZE);

    uint64_t *lib_rw_buf = (uint64_t *)calloc(64, sizeof(uint64_t));
    assert(lib_rw_buf != NULL);
    lib_rw_buf[3] = 0xb400000000000000ULL | (uint64_t)(uintptr_t)mask_holder;

    int mem_fd = open("/proc/self/mem", O_RDONLY);
    assert(mem_fd >= 0);

    /* 1) Test dynamic fallback path (fast path offset points at non-matching data) */
    MapsInfo maps_fallback = {0};
    maps_fallback.lib_base = (uint64_t)(uintptr_t)heap_buf; /* + 0x4F9048 is outside/invalid */
    assert(region_list_push(&maps_fallback.heap_regions,
                            (uint64_t)(uintptr_t)heap_buf,
                            (uint64_t)(uintptr_t)heap_buf + 4096) == 0);
    assert(region_list_push(&maps_fallback.lib_rw_regions,
                            (uint64_t)(uintptr_t)lib_rw_buf,
                            (uint64_t)(uintptr_t)lib_rw_buf + 64 * sizeof(uint64_t)) == 0);

    uint8_t out_rk[HWH_KEY_SIZE] = {0};
    uint8_t out_hk[HWH_KEY_SIZE] = {0};
    int rc = recover_key_from_mem_fd(mem_fd, &maps_fallback, page1, out_rk, out_hk);
    assert(rc == HWH_OK);
    assert(memcmp(out_rk, raw_key, HWH_KEY_SIZE) == 0);
    assert(memcmp(out_hk, hmac_key, HWH_KEY_SIZE) == 0);
    maps_info_free(&maps_fallback);

    /* 2) Test fast path (lib_base + 0x4F9048 directly holds pointer to exact 32-byte mask) */
    uint8_t *fake_lib = (uint8_t *)calloc(1, LIBSQLCIPHER_MASK_PTR_OFF + 16);
    assert(fake_lib != NULL);
    uint64_t direct_mask_ptr = 0xb400000000000000ULL | (uint64_t)(uintptr_t)(mask_holder + 16);
    memcpy(fake_lib + LIBSQLCIPHER_MASK_PTR_OFF, &direct_mask_ptr, sizeof(direct_mask_ptr));

    MapsInfo maps_fast = {0};
    maps_fast.lib_base = (uint64_t)(uintptr_t)fake_lib;
    assert(region_list_push(&maps_fast.heap_regions,
                            (uint64_t)(uintptr_t)heap_buf,
                            (uint64_t)(uintptr_t)heap_buf + 4096) == 0);
    /* Give empty-looking lib_rw so only fast path can succeed */
    uint64_t dummy_rw[4] = {0};
    assert(region_list_push(&maps_fast.lib_rw_regions,
                            (uint64_t)(uintptr_t)dummy_rw,
                            (uint64_t)(uintptr_t)dummy_rw + sizeof(dummy_rw)) == 0);

    memset(out_rk, 0, sizeof(out_rk));
    memset(out_hk, 0, sizeof(out_hk));
    rc = recover_key_from_mem_fd(mem_fd, &maps_fast, page1, out_rk, out_hk);
    assert(rc == HWH_OK);
    assert(memcmp(out_rk, raw_key, HWH_KEY_SIZE) == 0);
    assert(memcmp(out_hk, hmac_key, HWH_KEY_SIZE) == 0);

    maps_info_free(&maps_fast);
    close(mem_fd);
    free(fake_lib);
    free(lib_rw_buf);
    free(mask_holder);
    free(heap_buf);
    printf("PASS: test_recover_key_from_self_mem (fast path + dynamic fallback + TBI untagging)\n");
}

static void test_hex_copy_and_errors(void) {
    const char *hex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    uint8_t parsed[32];
    char roundtrip[65];
    assert(parse_hex_32(hex, parsed) == 0);
    for (size_t i = 0; i < 32; i++) {
        assert(parsed[i] == (uint8_t)i);
    }
    format_hex_32(parsed, roundtrip);
    assert(strcmp(hex, roundtrip) == 0);
    assert(parse_hex_32("short", parsed) != 0);
    assert(parse_hex_32("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", parsed) != 0);

    char src_tpl[] = "/tmp/hwh_src_XXXXXX";
    char dst_tpl[] = "/tmp/hwh_dst_XXXXXX";
    int sfd = mkstemp(src_tpl);
    int dfd = mkstemp(dst_tpl);
    assert(sfd >= 0 && dfd >= 0);
    close(dfd);

    uint8_t src_bytes[8192];
    for (size_t i = 0; i < sizeof(src_bytes); i++) {
        src_bytes[i] = (uint8_t)((i * 7U + 3U) & 0xFFU);
    }
    assert(write_all_fd(sfd, src_bytes, sizeof(src_bytes)) == 0);
    close(sfd);

    uint8_t page1[HWH_PAGE_SIZE] = {0};
    uint64_t copied = 0;
    assert(copy_snapshot(src_tpl, dst_tpl, page1, &copied) == HWH_OK);
    assert(copied == sizeof(src_bytes));
    assert(memcmp(page1, src_bytes, HWH_PAGE_SIZE) == 0);

    unlink(src_tpl);
    unlink(dst_tpl);

    uint8_t rk[32], hk[32];
    assert(recover_key_from_process("nonexistent_hwh_proc_000", page1, rk, hk) == HWH_ERR_NO_DAEMON);
    assert(strcmp(err_code_str(HWH_ERR_NO_DAEMON), "NO_DAEMON") == 0);
    assert(strcmp(err_code_str(HWH_ERR_MEM_NO_ACCESS), "MEM_NO_ACCESS") == 0);
    assert(strcmp(err_code_str(HWH_ERR_DST_OPEN_FAILED), "DST_OPEN_FAILED") == 0);
    printf("PASS: test_hex_copy_and_errors\n");
}

int main(void) {
    test_sha512_nist_vectors();
    test_derive_hmac_key_vector();
    test_verify_page1_hmac();
    test_parse_maps_stream();
    test_recover_key_from_self_mem();
    test_hex_copy_and_errors();
    printf("ALL NATIVE TESTS PASSED\n");
    return 0;
}
