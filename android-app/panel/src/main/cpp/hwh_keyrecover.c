#define _FILE_OFFSET_BITS 64
#define _GNU_SOURCE

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define HWH_PAGE_SIZE 4096U
#define HWH_SALT_SIZE 16U
#define HWH_IV_SIZE 16U
#define HWH_HMAC_SIZE 64U
#define HWH_KEY_SIZE 32U

#define LIBSQLCIPHER_MASK_PTR_OFF 0x4F9048ULL
#define UNTAG_MASK 0x00FFFFFFFFFFFFFFULL
#define ADDR_LOW6_MASK 0x0000FFFFFFFFFFFFULL

#define DEFAULT_PROCESS_PRIMARY "com.huawei.health:DaemonService"
#define DEFAULT_PROCESS_FALLBACK "com.huawei.health"

#define COPY_CHUNK_SIZE (256U * 1024U)
#define MEM_SCAN_CHUNK_SIZE (4U * 1024U * 1024U)
#define MAX_SALT_ADDRS 4096U
#define MAX_MASKED_PAIRS 4096U

enum {
    HWH_OK = 0,
    HWH_ERR_ARGS = 2,
    HWH_ERR_DB_NOT_FOUND = 10,
    HWH_ERR_DB_NO_ACCESS = 11,
    HWH_ERR_DB_TOO_SMALL = 12,
    HWH_ERR_NO_DAEMON = 13,
    HWH_ERR_NO_LIBSQLCIPHER = 14,
    HWH_ERR_NO_SALT = 15,
    HWH_ERR_NO_CTX = 16,
    HWH_ERR_UNMASK_FAILED = 17,
    HWH_ERR_OOM = 18,
    HWH_ERR_DB_READ_FAILED = 19,
    HWH_ERR_MEM_NO_ACCESS = 20,
    HWH_ERR_DST_OPEN_FAILED = 21
};

static const uint8_t SQLITE_HEADER[16] = {
    'S', 'Q', 'L', 'i', 't', 'e', ' ', 'f',
    'o', 'r', 'm', 'a', 't', ' ', '3', '\0'
};

static void secure_zero(void *ptr, size_t len) {
    volatile uint8_t *p = (volatile uint8_t *)ptr;
    while (len--) {
        *p++ = 0;
    }
}

static int ct_memcmp(const uint8_t *a, const uint8_t *b, size_t len) {
    uint8_t diff = 0;
    for (size_t i = 0; i < len; i++) {
        diff |= (uint8_t)(a[i] ^ b[i]);
    }
    return diff != 0;
}

/* ---------------- SHA-512 & HMAC-SHA512 (FIPS 180-4 / RFC 2104) ---------------- */

typedef struct {
    uint64_t state[8];
    uint64_t count_lo;
    uint64_t count_hi;
    uint8_t buf[128];
    size_t buf_len;
} sha512_ctx;

static inline uint64_t rotr64(uint64_t x, unsigned n) {
    return (x >> n) | (x << (64U - n));
}

static inline uint64_t load_be64(const uint8_t *p) {
    return ((uint64_t)p[0] << 56) | ((uint64_t)p[1] << 48) |
           ((uint64_t)p[2] << 40) | ((uint64_t)p[3] << 32) |
           ((uint64_t)p[4] << 24) | ((uint64_t)p[5] << 16) |
           ((uint64_t)p[6] << 8)  | ((uint64_t)p[7]);
}

static inline void store_be64(uint8_t *p, uint64_t v) {
    p[0] = (uint8_t)(v >> 56);
    p[1] = (uint8_t)(v >> 48);
    p[2] = (uint8_t)(v >> 40);
    p[3] = (uint8_t)(v >> 32);
    p[4] = (uint8_t)(v >> 24);
    p[5] = (uint8_t)(v >> 16);
    p[6] = (uint8_t)(v >> 8);
    p[7] = (uint8_t)(v);
}

static const uint64_t SHA512_K[80] = {
    0x428a2f98d728ae22ULL, 0x7137449123ef65cdULL, 0xb5c0fbcfec4d3b2fULL, 0xe9b5dba58189dbbcULL,
    0x3956c25bf348b538ULL, 0x59f111f1b605d019ULL, 0x923f82a4af194f9bULL, 0xab1c5ed5da6d8118ULL,
    0xd807aa98a3030242ULL, 0x12835b0145706fbeULL, 0x243185be4ee4b28cULL, 0x550c7dc3d5ffb4e2ULL,
    0x72be5d74f27b896fULL, 0x80deb1fe3b1696b1ULL, 0x9bdc06a725c71235ULL, 0xc19bf174cf692694ULL,
    0xe49b69c19ef14ad2ULL, 0xefbe4786384f25e3ULL, 0x0fc19dc68b8cd5b5ULL, 0x240ca1cc77ac9c65ULL,
    0x2de92c6f592b0275ULL, 0x4a7484aa6ea6e483ULL, 0x5cb0a9dcbd41fbd4ULL, 0x76f988da831153b5ULL,
    0x983e5152ee66dfabULL, 0xa831c66d2db43210ULL, 0xb00327c898fb213fULL, 0xbf597fc7beef0ee4ULL,
    0xc6e00bf33da88fc2ULL, 0xd5a79147930aa725ULL, 0x06ca6351e003826fULL, 0x142929670a0e6e70ULL,
    0x27b70a8546d22ffcULL, 0x2e1b21385c26c926ULL, 0x4d2c6dfc5ac42aedULL, 0x53380d139d95b3dfULL,
    0x650a73548baf63deULL, 0x766a0abb3c77b2a8ULL, 0x81c2c92e47edaee6ULL, 0x92722c851482353bULL,
    0xa2bfe8a14cf10364ULL, 0xa81a664bbc423001ULL, 0xc24b8b70d0f89791ULL, 0xc76c51a30654be30ULL,
    0xd192e819d6ef5218ULL, 0xd69906245565a910ULL, 0xf40e35855771202aULL, 0x106aa07032bbd1b8ULL,
    0x19a4c116b8d2d0c8ULL, 0x1e376c085141ab53ULL, 0x2748774cdf8eeb99ULL, 0x34b0bcb5e19b48a8ULL,
    0x391c0cb3c5c95a63ULL, 0x4ed8aa4ae3418acbULL, 0x5b9cca4f7763e373ULL, 0x682e6ff3d6b2b8a3ULL,
    0x748f82ee5defb2fcULL, 0x78a5636f43172f60ULL, 0x84c87814a1f0ab72ULL, 0x8cc702081a6439ecULL,
    0x90befffa23631e28ULL, 0xa4506cebde82bde9ULL, 0xbef9a3f7b2c67915ULL, 0xc67178f2e372532bULL,
    0xca273eceea26619cULL, 0xd186b8c721c0c207ULL, 0xeada7dd6cde0eb1eULL, 0xf57d4f7fee6ed178ULL,
    0x06f067aa72176fbaULL, 0x0a637dc5a2c898a6ULL, 0x113f9804bef90daeULL, 0x1b710b35131c471bULL,
    0x28db77f523047d84ULL, 0x32caab7b40c72493ULL, 0x3c9ebe0a15c9bebcULL, 0x431d67c49c100d4cULL,
    0x4cc5d4becb3e42b6ULL, 0x597f299cfc657e2aULL, 0x5fcb6fab3ad6faecULL, 0x6c44198c4a475817ULL
};

static void sha512_transform(sha512_ctx *ctx, const uint8_t block[128]) {
    uint64_t w[80];
    for (size_t i = 0; i < 16; i++) {
        w[i] = load_be64(block + i * 8);
    }
    for (size_t i = 16; i < 80; i++) {
        uint64_t s0 = rotr64(w[i - 15], 1) ^ rotr64(w[i - 15], 8) ^ (w[i - 15] >> 7);
        uint64_t s1 = rotr64(w[i - 2], 19) ^ rotr64(w[i - 2], 61) ^ (w[i - 2] >> 6);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }

    uint64_t a = ctx->state[0];
    uint64_t b = ctx->state[1];
    uint64_t c = ctx->state[2];
    uint64_t d = ctx->state[3];
    uint64_t e = ctx->state[4];
    uint64_t f = ctx->state[5];
    uint64_t g = ctx->state[6];
    uint64_t h = ctx->state[7];

    for (size_t i = 0; i < 80; i++) {
        uint64_t S1 = rotr64(e, 14) ^ rotr64(e, 18) ^ rotr64(e, 41);
        uint64_t ch = (e & f) ^ ((~e) & g);
        uint64_t temp1 = h + S1 + ch + SHA512_K[i] + w[i];
        uint64_t S0 = rotr64(a, 28) ^ rotr64(a, 34) ^ rotr64(a, 39);
        uint64_t maj = (a & b) ^ (a & c) ^ (b & c);
        uint64_t temp2 = S0 + maj;

        h = g;
        g = f;
        f = e;
        e = d + temp1;
        d = c;
        c = b;
        b = a;
        a = temp1 + temp2;
    }

    ctx->state[0] += a;
    ctx->state[1] += b;
    ctx->state[2] += c;
    ctx->state[3] += d;
    ctx->state[4] += e;
    ctx->state[5] += f;
    ctx->state[6] += g;
    ctx->state[7] += h;
    secure_zero(w, sizeof(w));
}

static void sha512_init(sha512_ctx *ctx) {
    ctx->state[0] = 0x6a09e667f3bcc908ULL;
    ctx->state[1] = 0xbb67ae8584caa73bULL;
    ctx->state[2] = 0x3c6ef372fe94f82bULL;
    ctx->state[3] = 0xa54ff53a5f1d36f1ULL;
    ctx->state[4] = 0x510e527fade682d1ULL;
    ctx->state[5] = 0x9b05688c2b3e6c1fULL;
    ctx->state[6] = 0x1f83d9abfb41bd6bULL;
    ctx->state[7] = 0x5be0cd19137e2179ULL;
    ctx->count_lo = 0;
    ctx->count_hi = 0;
    ctx->buf_len = 0;
}

static void sha512_update(sha512_ctx *ctx, const uint8_t *data, size_t len) {
    uint64_t add_bits = (uint64_t)len << 3;
    uint64_t old_lo = ctx->count_lo;
    ctx->count_lo += add_bits;
    if (ctx->count_lo < old_lo) {
        ctx->count_hi++;
    }
    ctx->count_hi += (uint64_t)len >> 61;

    while (len > 0) {
        size_t space = 128U - ctx->buf_len;
        size_t take = len < space ? len : space;
        memcpy(ctx->buf + ctx->buf_len, data, take);
        ctx->buf_len += take;
        data += take;
        len -= take;
        if (ctx->buf_len == 128U) {
            sha512_transform(ctx, ctx->buf);
            ctx->buf_len = 0;
        }
    }
}

static void sha512_final(sha512_ctx *ctx, uint8_t out[64]) {
    ctx->buf[ctx->buf_len++] = 0x80;
    if (ctx->buf_len > 112U) {
        memset(ctx->buf + ctx->buf_len, 0, 128U - ctx->buf_len);
        sha512_transform(ctx, ctx->buf);
        ctx->buf_len = 0;
    }
    memset(ctx->buf + ctx->buf_len, 0, 112U - ctx->buf_len);
    store_be64(ctx->buf + 112U, ctx->count_hi);
    store_be64(ctx->buf + 120U, ctx->count_lo);
    sha512_transform(ctx, ctx->buf);

    for (size_t i = 0; i < 8; i++) {
        store_be64(out + i * 8, ctx->state[i]);
    }
    secure_zero(ctx, sizeof(*ctx));
}

static void sha512(const uint8_t *data, size_t len, uint8_t out[64]) {
    sha512_ctx ctx;
    sha512_init(&ctx);
    sha512_update(&ctx, data, len);
    sha512_final(&ctx, out);
}

static void hmac_sha512(
    const uint8_t *key,
    size_t key_len,
    const uint8_t *msg,
    size_t msg_len,
    uint8_t out[64]
) {
    uint8_t k_pad[128];
    uint8_t i_pad[128];
    uint8_t o_pad[128];
    uint8_t inner_hash[64];

    memset(k_pad, 0, sizeof(k_pad));
    if (key_len > 128U) {
        sha512(key, key_len, k_pad);
    } else if (key_len > 0) {
        memcpy(k_pad, key, key_len);
    }

    for (size_t i = 0; i < 128U; i++) {
        i_pad[i] = (uint8_t)(k_pad[i] ^ 0x36U);
        o_pad[i] = (uint8_t)(k_pad[i] ^ 0x5CU);
    }

    sha512_ctx ctx;
    sha512_init(&ctx);
    sha512_update(&ctx, i_pad, sizeof(i_pad));
    sha512_update(&ctx, msg, msg_len);
    sha512_final(&ctx, inner_hash);

    sha512_init(&ctx);
    sha512_update(&ctx, o_pad, sizeof(o_pad));
    sha512_update(&ctx, inner_hash, sizeof(inner_hash));
    sha512_final(&ctx, out);

    secure_zero(k_pad, sizeof(k_pad));
    secure_zero(i_pad, sizeof(i_pad));
    secure_zero(o_pad, sizeof(o_pad));
    secure_zero(inner_hash, sizeof(inner_hash));
}

static void derive_hmac_key(
    const uint8_t raw_key[HWH_KEY_SIZE],
    const uint8_t salt[HWH_SALT_SIZE],
    uint8_t out_hmac_key[HWH_KEY_SIZE]
) {
    uint8_t input[HWH_SALT_SIZE + 4];
    for (size_t i = 0; i < HWH_SALT_SIZE; i++) {
        input[i] = (uint8_t)(salt[i] ^ 0x3AU);
    }
    input[HWH_SALT_SIZE + 0] = 0;
    input[HWH_SALT_SIZE + 1] = 0;
    input[HWH_SALT_SIZE + 2] = 0;
    input[HWH_SALT_SIZE + 3] = 1;

    uint8_t u1[64];
    uint8_t u2[64];
    hmac_sha512(raw_key, HWH_KEY_SIZE, input, sizeof(input), u1);
    hmac_sha512(raw_key, HWH_KEY_SIZE, u1, sizeof(u1), u2);

    for (size_t i = 0; i < HWH_KEY_SIZE; i++) {
        out_hmac_key[i] = (uint8_t)(u1[i] ^ u2[i]);
    }

    secure_zero(input, sizeof(input));
    secure_zero(u1, sizeof(u1));
    secure_zero(u2, sizeof(u2));
}

static int verify_page1_hmac(
    const uint8_t page1[HWH_PAGE_SIZE],
    const uint8_t hmac_key[HWH_KEY_SIZE]
) {
    uint8_t msg[HWH_PAGE_SIZE - HWH_SALT_SIZE - HWH_HMAC_SIZE + 4];
    const size_t body_len = HWH_PAGE_SIZE - HWH_SALT_SIZE - HWH_HMAC_SIZE;
    memcpy(msg, page1 + HWH_SALT_SIZE, body_len);
    msg[body_len + 0] = 1;
    msg[body_len + 1] = 0;
    msg[body_len + 2] = 0;
    msg[body_len + 3] = 0;

    uint8_t mac[64];
    hmac_sha512(hmac_key, HWH_KEY_SIZE, msg, sizeof(msg), mac);
    int ok = (ct_memcmp(mac, page1 + (HWH_PAGE_SIZE - HWH_HMAC_SIZE), HWH_HMAC_SIZE) == 0);
    secure_zero(msg, sizeof(msg));
    secure_zero(mac, sizeof(mac));
    return ok;
}

/* ---------------- Maps & Memory Scanning ---------------- */

typedef struct {
    uint64_t start;
    uint64_t end;
} MemRegion;

typedef struct {
    MemRegion *items;
    size_t count;
    size_t cap;
} RegionList;

typedef struct {
    uint64_t lib_base;
    RegionList heap_regions;
    RegionList lib_rw_regions;
} MapsInfo;

typedef struct {
    uint8_t mk1[HWH_KEY_SIZE];
    uint8_t mk2[HWH_KEY_SIZE];
} MaskedPair;

typedef struct {
    MaskedPair *items;
    size_t count;
    size_t cap;
} MaskedPairList;

typedef struct {
    uint64_t *items;
    size_t count;
    size_t cap;
} AddrList;

static int region_list_push(RegionList *list, uint64_t start, uint64_t end) {
    if (list->count == list->cap) {
        size_t new_cap = list->cap ? list->cap * 2 : 64;
        MemRegion *next = (MemRegion *)realloc(list->items, new_cap * sizeof(MemRegion));
        if (!next) {
            return -1;
        }
        list->items = next;
        list->cap = new_cap;
    }
    list->items[list->count].start = start;
    list->items[list->count].end = end;
    list->count++;
    return 0;
}

static void maps_info_free(MapsInfo *info) {
    free(info->heap_regions.items);
    free(info->lib_rw_regions.items);
    memset(info, 0, sizeof(*info));
}

static int addr_list_push(AddrList *list, uint64_t val, size_t max_count) {
    if (list->count >= max_count) {
        return 0;
    }
    if (list->count == list->cap) {
        size_t new_cap = list->cap ? list->cap * 2 : 32;
        uint64_t *next = (uint64_t *)realloc(list->items, new_cap * sizeof(uint64_t));
        if (!next) {
            return -1;
        }
        list->items = next;
        list->cap = new_cap;
    }
    list->items[list->count++] = val;
    return 0;
}

static int masked_pair_push(
    MaskedPairList *list,
    const uint8_t mk1[HWH_KEY_SIZE],
    const uint8_t mk2[HWH_KEY_SIZE]
) {
    for (size_t i = 0; i < list->count; i++) {
        if (memcmp(list->items[i].mk1, mk1, HWH_KEY_SIZE) == 0 &&
            memcmp(list->items[i].mk2, mk2, HWH_KEY_SIZE) == 0) {
            return 0;
        }
    }
    if (list->count >= MAX_MASKED_PAIRS) {
        return 0;
    }
    if (list->count == list->cap) {
        size_t new_cap = list->cap ? list->cap * 2 : 16;
        MaskedPair *next = (MaskedPair *)realloc(list->items, new_cap * sizeof(MaskedPair));
        if (!next) {
            return -1;
        }
        list->items = next;
        list->cap = new_cap;
    }
    memcpy(list->items[list->count].mk1, mk1, HWH_KEY_SIZE);
    memcpy(list->items[list->count].mk2, mk2, HWH_KEY_SIZE);
    list->count++;
    return 0;
}

static void masked_pair_list_free(MaskedPairList *list) {
    if (list->items && list->count > 0) {
        secure_zero(list->items, list->count * sizeof(MaskedPair));
    }
    free(list->items);
    memset(list, 0, sizeof(*list));
}

static int parse_maps_line(
    const char *line,
    uint64_t *out_start,
    uint64_t *out_end,
    char perms_out[8],
    const char **out_name
) {
    const char *p = line;
    char *endptr = NULL;

    uint64_t s = strtoull(p, &endptr, 16);
    if (endptr == p || *endptr != '-') {
        return 0;
    }
    p = endptr + 1;
    uint64_t e = strtoull(p, &endptr, 16);
    if (endptr == p || (*endptr != ' ' && *endptr != '\t')) {
        return 0;
    }
    p = endptr;
    while (*p == ' ' || *p == '\t') {
        p++;
    }

    size_t pi = 0;
    while (*p && *p != ' ' && *p != '\t' && *p != '\n' && *p != '\r') {
        if (pi < 7) {
            perms_out[pi++] = *p;
        }
        p++;
    }
    perms_out[pi] = '\0';
    if (pi < 2) {
        return 0;
    }

    /* Skip offset, dev, inode (tokens 3, 4, 5) */
    for (int tok = 0; tok < 3; tok++) {
        while (*p == ' ' || *p == '\t') {
            p++;
        }
        if (!*p || *p == '\n' || *p == '\r') {
            *out_start = s;
            *out_end = e;
            *out_name = "";
            return 1;
        }
        while (*p && *p != ' ' && *p != '\t' && *p != '\n' && *p != '\r') {
            p++;
        }
    }

    while (*p == ' ' || *p == '\t') {
        p++;
    }
    *out_start = s;
    *out_end = e;
    *out_name = p;
    return 1;
}

static int parse_maps_stream(FILE *f, MapsInfo *out) {
    memset(out, 0, sizeof(*out));
    char line[4096];
    int after_lib_rw = 0;
    uint64_t prev_end = 0;

    while (fgets(line, sizeof(line), f) != NULL) {
        size_t len = strlen(line);
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r' ||
                           line[len - 1] == ' ' || line[len - 1] == '\t')) {
            line[--len] = '\0';
        }
        if (len == 0) {
            continue;
        }

        uint64_t s = 0, e = 0;
        char perms[8];
        const char *name = "";
        if (!parse_maps_line(line, &s, &e, perms, &name)) {
            after_lib_rw = 0;
            continue;
        }

        int is_rw = (perms[0] == 'r' && perms[1] == 'w');
        if (strstr(name, "libsqlcipher.so") != NULL) {
            if (out->lib_base == 0) {
                out->lib_base = s;
            }
            if (is_rw) {
                if (region_list_push(&out->lib_rw_regions, s, e) != 0) {
                    return -1;
                }
                after_lib_rw = 1;
                prev_end = e;
            } else {
                after_lib_rw = 0;
            }
        } else if (after_lib_rw && s == prev_end && is_rw) {
            if (region_list_push(&out->lib_rw_regions, s, e) != 0) {
                return -1;
            }
            prev_end = e;
        } else {
            after_lib_rw = 0;
        }

        if (is_rw && e > s && (e - s) <= 256ULL * 1024ULL * 1024ULL) {
            if (name[0] == '\0' ||
                strstr(name, "libc_malloc") != NULL ||
                strstr(name, "scudo") != NULL ||
                strcmp(name, "[heap]") == 0) {
                if (region_list_push(&out->heap_regions, s, e) != 0) {
                    return -1;
                }
            }
        }
    }
    return 0;
}

static inline int is_valid_ptr(uint64_t p) {
    return p > 0x1000000000ULL && p < 0x800000000000ULL;
}

static ssize_t pread_full(int fd, void *buf, size_t len, uint64_t addr) {
    uint8_t *dst = (uint8_t *)buf;
    size_t total = 0;
    while (total < len) {
        ssize_t n = pread(fd, dst + total, len - total, (off_t)(addr + total));
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            return total > 0 ? (ssize_t)total : -1;
        }
        if (n == 0) {
            break;
        }
        total += (size_t)n;
    }
    return (ssize_t)total;
}

static int cmp_u64(const void *a, const void *b) {
    uint64_t va = *(const uint64_t *)a;
    uint64_t vb = *(const uint64_t *)b;
    if (va < vb) return -1;
    if (va > vb) return 1;
    return 0;
}

static int has_u64_sorted(const uint64_t *arr, size_t n, uint64_t target) {
    size_t lo = 0;
    size_t hi = n;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (arr[mid] == target) {
            return 1;
        }
        if (arr[mid] < target) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return 0;
}

static int try_mask(
    const uint8_t mask[HWH_KEY_SIZE],
    const MaskedPairList *pairs,
    const uint8_t salt[HWH_SALT_SIZE],
    const uint8_t page1[HWH_PAGE_SIZE],
    uint8_t out_rk[HWH_KEY_SIZE],
    uint8_t out_hk[HWH_KEY_SIZE]
) {
    uint8_t rk[HWH_KEY_SIZE];
    uint8_t hk[HWH_KEY_SIZE];
    uint8_t derived[HWH_KEY_SIZE];

    for (size_t i = 0; i < pairs->count; i++) {
        for (size_t b = 0; b < HWH_KEY_SIZE; b++) {
            rk[b] = (uint8_t)(pairs->items[i].mk1[b] ^ mask[b]);
            hk[b] = (uint8_t)(pairs->items[i].mk2[b] ^ mask[b]);
        }
        derive_hmac_key(rk, salt, derived);
        if (ct_memcmp(derived, hk, HWH_KEY_SIZE) == 0 && verify_page1_hmac(page1, hk)) {
            memcpy(out_rk, rk, HWH_KEY_SIZE);
            memcpy(out_hk, hk, HWH_KEY_SIZE);
            secure_zero(rk, sizeof(rk));
            secure_zero(hk, sizeof(hk));
            secure_zero(derived, sizeof(derived));
            return 1;
        }
    }

    secure_zero(rk, sizeof(rk));
    secure_zero(hk, sizeof(hk));
    secure_zero(derived, sizeof(derived));
    return 0;
}

#define PTR_SET_SLOTS 16384U

static int ptr_set_insert(uint64_t *table, uint64_t ptr) {
    uint64_t h = (ptr * 11400714819323198485ULL) >> 50;
    for (size_t probe = 0; probe < 16; probe++) {
        size_t idx = (size_t)((h + probe) & (PTR_SET_SLOTS - 1U));
        if (table[idx] == ptr) {
            return 0;
        }
        if (table[idx] == 0) {
            table[idx] = ptr;
            return 1;
        }
    }
    return 1;
}

static int recover_key_from_mem_fd(
    int mem_fd,
    const MapsInfo *maps,
    const uint8_t page1[HWH_PAGE_SIZE],
    uint8_t out_rk[HWH_KEY_SIZE],
    uint8_t out_hk[HWH_KEY_SIZE]
) {
    if (maps->lib_base == 0 || maps->lib_rw_regions.count == 0) {
        return HWH_ERR_NO_LIBSQLCIPHER;
    }

    const uint8_t *salt = page1;
    uint8_t *buf = (uint8_t *)malloc(MEM_SCAN_CHUNK_SIZE);
    if (!buf) {
        return HWH_ERR_OOM;
    }

    int status = HWH_ERR_UNMASK_FAILED;
    AddrList salt_low6 = {0};
    MaskedPairList pairs = {0};
    uint64_t *seen_ptrs = NULL;

    /* Pass 1: find all addresses in heap_regions matching the 16-byte DB salt */
    for (size_t r = 0; r < maps->heap_regions.count; r++) {
        uint64_t cur = maps->heap_regions.items[r].start;
        uint64_t end = maps->heap_regions.items[r].end;
        while (cur < end) {
            uint64_t rem = end - cur;
            size_t to_read = rem > MEM_SCAN_CHUNK_SIZE ? MEM_SCAN_CHUNK_SIZE : (size_t)rem;
            ssize_t n = pread_full(mem_fd, buf, to_read, cur);
            if (n <= 0) {
                cur = (cur & ~4095ULL) + 65536ULL;
                continue;
            }
            if (n >= (ssize_t)HWH_SALT_SIZE) {
                size_t limit = (size_t)n - HWH_SALT_SIZE;
                for (size_t idx = 0; idx <= limit; idx++) {
                    if (buf[idx] == salt[0] && memcmp(buf + idx, salt, HWH_SALT_SIZE) == 0) {
                        uint64_t low6 = (cur + idx) & ADDR_LOW6_MASK;
                        if (addr_list_push(&salt_low6, low6, MAX_SALT_ADDRS) != 0) {
                            status = HWH_ERR_OOM;
                            goto cleanup;
                        }
                    }
                }
            }
            if (cur + (uint64_t)n >= end) {
                break;
            }
            if ((size_t)n < to_read) {
                cur = ((cur + (uint64_t)n) & ~4095ULL) + 4096ULL;
                continue;
            }
            size_t step = (size_t)n - (HWH_SALT_SIZE - 1U);
            if (step == 0) {
                break;
            }
            cur += step;
        }
    }

    if (salt_low6.count == 0) {
        status = HWH_ERR_NO_SALT;
        goto cleanup;
    }

    qsort(salt_low6.items, salt_low6.count, sizeof(uint64_t), cmp_u64);
    size_t uniq = 0;
    for (size_t i = 0; i < salt_low6.count; i++) {
        if (uniq == 0 || salt_low6.items[i] != salt_low6.items[uniq - 1]) {
            salt_low6.items[uniq++] = salt_low6.items[i];
        }
    }
    salt_low6.count = uniq;

    /* Pass 2: single scan over heap_regions for 8-byte aligned salt pointers -> read_ctx -> (mk1, mk2) */
    for (size_t r = 0; r < maps->heap_regions.count; r++) {
        uint64_t cur = maps->heap_regions.items[r].start;
        uint64_t end = maps->heap_regions.items[r].end;
        while (cur < end) {
            uint64_t rem = end - cur;
            size_t to_read = rem > MEM_SCAN_CHUNK_SIZE ? MEM_SCAN_CHUNK_SIZE : (size_t)rem;
            ssize_t n = pread_full(mem_fd, buf, to_read, cur);
            if (n <= 0) {
                cur = (cur & ~4095ULL) + 65536ULL;
                continue;
            }
            if (n >= 40) {
                for (size_t idx = 0; idx + 40 <= (size_t)n; idx += 8) {
                    uint64_t val = 0;
                    memcpy(&val, buf + idx, sizeof(val));
                    uint64_t low6 = val & ADDR_LOW6_MASK;
                    if (!has_u64_sorted(salt_low6.items, salt_low6.count, low6)) {
                        continue;
                    }
                    uint64_t rctx = 0;
                    memcpy(&rctx, buf + idx + 32, sizeof(rctx));
                    rctx &= UNTAG_MASK;
                    if (!is_valid_ptr(rctx)) {
                        continue;
                    }
                    uint64_t rc[4];
                    if (pread_full(mem_fd, rc, sizeof(rc), rctx) != (ssize_t)sizeof(rc)) {
                        continue;
                    }
                    uint64_t kp = rc[1] & UNTAG_MASK;
                    uint64_t hp = rc[2] & UNTAG_MASK;
                    if (!is_valid_ptr(kp) || !is_valid_ptr(hp)) {
                        continue;
                    }
                    uint8_t mk1[HWH_KEY_SIZE];
                    uint8_t mk2[HWH_KEY_SIZE];
                    if (pread_full(mem_fd, mk1, HWH_KEY_SIZE, kp) == HWH_KEY_SIZE &&
                        pread_full(mem_fd, mk2, HWH_KEY_SIZE, hp) == HWH_KEY_SIZE) {
                        if (masked_pair_push(&pairs, mk1, mk2) != 0) {
                            secure_zero(mk1, sizeof(mk1));
                            secure_zero(mk2, sizeof(mk2));
                            status = HWH_ERR_OOM;
                            goto cleanup;
                        }
                    }
                    secure_zero(mk1, sizeof(mk1));
                    secure_zero(mk2, sizeof(mk2));
                }
            }
            if (cur + (uint64_t)n >= end) {
                break;
            }
            if ((size_t)n < to_read) {
                cur = ((cur + (uint64_t)n) & ~4095ULL) + 4096ULL;
                continue;
            }
            size_t step = ((size_t)n - 32U) & ~7ULL;
            if (step == 0) {
                break;
            }
            cur += step;
        }
    }

    if (pairs.count == 0) {
        status = HWH_ERR_NO_CTX;
        goto cleanup;
    }

    /* Pass 3a: Fast path via known libsqlcipher.so BSS mask pointer offset */
    {
        uint64_t raw_ptr = 0;
        if (pread_full(mem_fd, &raw_ptr, sizeof(raw_ptr), maps->lib_base + LIBSQLCIPHER_MASK_PTR_OFF) == (ssize_t)sizeof(raw_ptr)) {
            uint64_t ptr = raw_ptr & UNTAG_MASK;
            if (is_valid_ptr(ptr)) {
                uint8_t mask[HWH_KEY_SIZE];
                if (pread_full(mem_fd, mask, sizeof(mask), ptr) == (ssize_t)sizeof(mask)) {
                    int found = try_mask(mask, &pairs, salt, page1, out_rk, out_hk);
                    secure_zero(mask, sizeof(mask));
                    if (found) {
                        status = HWH_OK;
                        goto cleanup;
                    }
                }
            }
        }
    }

    /* Pass 3b: Dynamic fallback across pointers in libsqlcipher.so rw-p + contiguous .bss */
    seen_ptrs = (uint64_t *)calloc(PTR_SET_SLOTS, sizeof(uint64_t));
    if (!seen_ptrs) {
        status = HWH_ERR_OOM;
        goto cleanup;
    }

    for (size_t r = 0; r < maps->lib_rw_regions.count; r++) {
        uint64_t cur = maps->lib_rw_regions.items[r].start;
        uint64_t end = maps->lib_rw_regions.items[r].end;
        while (cur < end) {
            uint64_t rem = end - cur;
            size_t to_read = rem > MEM_SCAN_CHUNK_SIZE ? MEM_SCAN_CHUNK_SIZE : (size_t)rem;
            ssize_t n = pread_full(mem_fd, buf, to_read, cur);
            if (n < 8) {
                break;
            }
            for (size_t off = 0; off + 8 <= (size_t)n; off += 8) {
                uint64_t raw_ptr = 0;
                memcpy(&raw_ptr, buf + off, sizeof(raw_ptr));
                uint64_t ptr = raw_ptr & UNTAG_MASK;
                if (!is_valid_ptr(ptr)) {
                    continue;
                }
                if (!ptr_set_insert(seen_ptrs, ptr)) {
                    continue;
                }
                uint8_t candidate[128];
                ssize_t got = pread_full(mem_fd, candidate, sizeof(candidate), ptr);
                if (got >= (ssize_t)HWH_KEY_SIZE) {
                    for (size_t b_off = 0; b_off + HWH_KEY_SIZE <= (size_t)got; b_off += 8) {
                        if (try_mask(candidate + b_off, &pairs, salt, page1, out_rk, out_hk)) {
                            secure_zero(candidate, sizeof(candidate));
                            status = HWH_OK;
                            goto cleanup;
                        }
                    }
                }
                secure_zero(candidate, sizeof(candidate));
            }
            if (cur + (uint64_t)n >= end) {
                break;
            }
            size_t step = (size_t)n & ~7ULL;
            if (step == 0) {
                break;
            }
            cur += step;
        }
    }

cleanup:
    if (buf) {
        secure_zero(buf, MEM_SCAN_CHUNK_SIZE);
        free(buf);
    }
    free(seen_ptrs);
    free(salt_low6.items);
    masked_pair_list_free(&pairs);
    return status;
}

static int find_pid(const char *proc_name) {
    DIR *dir = opendir("/proc");
    if (!dir) {
        return -1;
    }
    size_t target_len = strlen(proc_name);
    struct dirent *ent;
    int found = -1;

    while ((ent = readdir(dir)) != NULL) {
        const char *name = ent->d_name;
        if (!isdigit((unsigned char)name[0])) {
            continue;
        }
        int all_digits = 1;
        for (size_t i = 0; name[i]; i++) {
            if (!isdigit((unsigned char)name[i])) {
                all_digits = 0;
                break;
            }
        }
        if (!all_digits) {
            continue;
        }

        char path[64];
        snprintf(path, sizeof(path), "/proc/%s/cmdline", name);
        int fd = open(path, O_RDONLY);
        if (fd < 0) {
            continue;
        }
        char cmd[256];
        ssize_t n = read(fd, cmd, sizeof(cmd) - 1);
        close(fd);
        if (n <= 0) {
            continue;
        }
        while (n > 0 && cmd[n - 1] == '\0') {
            n--;
        }
        if ((size_t)n == target_len && memcmp(cmd, proc_name, target_len) == 0) {
            found = atoi(name);
            break;
        }
    }
    closedir(dir);
    return found;
}

static int recover_key_from_process(
    const char *proc_name,
    const uint8_t page1[HWH_PAGE_SIZE],
    uint8_t out_rk[HWH_KEY_SIZE],
    uint8_t out_hk[HWH_KEY_SIZE]
) {
    int pid = find_pid(proc_name);
    if (pid < 0) {
        return HWH_ERR_NO_DAEMON;
    }

    char maps_path[64];
    char mem_path[64];
    snprintf(maps_path, sizeof(maps_path), "/proc/%d/maps", pid);
    snprintf(mem_path, sizeof(mem_path), "/proc/%d/mem", pid);

    FILE *maps_file = fopen(maps_path, "r");
    if (!maps_file) {
        return HWH_ERR_NO_LIBSQLCIPHER;
    }
    MapsInfo maps;
    if (parse_maps_stream(maps_file, &maps) != 0) {
        fclose(maps_file);
        maps_info_free(&maps);
        return HWH_ERR_OOM;
    }
    fclose(maps_file);

    if (maps.lib_base == 0 || maps.lib_rw_regions.count == 0) {
        maps_info_free(&maps);
        return HWH_ERR_NO_LIBSQLCIPHER;
    }

    int mem_fd = open(mem_path, O_RDONLY);
    if (mem_fd < 0) {
        fprintf(stderr, "open %s failed: %s\n", mem_path, strerror(errno));
        maps_info_free(&maps);
        return HWH_ERR_MEM_NO_ACCESS;
    }

    int rc = recover_key_from_mem_fd(mem_fd, &maps, page1, out_rk, out_hk);
    close(mem_fd);
    maps_info_free(&maps);
    return rc;
}

/* ---------------- Hex & I/O Helpers ---------------- */

static int parse_hex_32(const char *hex, uint8_t out[HWH_KEY_SIZE]) {
    if (strlen(hex) != 64U) {
        return -1;
    }
    for (size_t i = 0; i < 32U; i++) {
        char c1 = hex[i * 2U];
        char c2 = hex[i * 2U + 1U];
        if (!isxdigit((unsigned char)c1) || !isxdigit((unsigned char)c2)) {
            return -1;
        }
        unsigned hi = (unsigned)(isdigit((unsigned char)c1) ? c1 - '0' : (tolower((unsigned char)c1) - 'a' + 10));
        unsigned lo = (unsigned)(isdigit((unsigned char)c2) ? c2 - '0' : (tolower((unsigned char)c2) - 'a' + 10));
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return 0;
}

static void format_hex_32(const uint8_t bytes[HWH_KEY_SIZE], char out[65]) {
    static const char hex_chars[] = "0123456789abcdef";
    for (size_t i = 0; i < HWH_KEY_SIZE; i++) {
        out[i * 2U] = hex_chars[(bytes[i] >> 4) & 0x0FU];
        out[i * 2U + 1U] = hex_chars[bytes[i] & 0x0FU];
    }
    out[64] = '\0';
}

static int write_all_fd(int fd, const uint8_t *buf, size_t len) {
    size_t off = 0;
    while (off < len) {
        ssize_t w = write(fd, buf + off, len - off);
        if (w < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        off += (size_t)w;
    }
    return 0;
}

static int copy_snapshot(
    const char *src_path,
    const char *dst_path,
    uint8_t page1_out[HWH_PAGE_SIZE],
    uint64_t *bytes_out
) {
    *bytes_out = 0;
    int src_fd = open(src_path, O_RDONLY);
    if (src_fd < 0) {
        int saved_err = errno;
        fprintf(stderr, "open src failed: %s\n", strerror(saved_err));
        if (saved_err == ENOENT) {
            return HWH_ERR_DB_NOT_FOUND;
        }
        if (saved_err == EACCES || saved_err == EPERM) {
            return HWH_ERR_DB_NO_ACCESS;
        }
        return HWH_ERR_DB_READ_FAILED;
    }

    int dst_fd = open(dst_path, O_WRONLY | O_TRUNC);
    if (dst_fd < 0 && errno == ENOENT) {
        dst_fd = open(dst_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    }
    if (dst_fd < 0) {
        fprintf(stderr, "open dst failed: %s\n", strerror(errno));
        close(src_fd);
        return HWH_ERR_DST_OPEN_FAILED;
    }

    uint8_t *buf = (uint8_t *)malloc(COPY_CHUNK_SIZE);
    if (!buf) {
        close(src_fd);
        close(dst_fd);
        return HWH_ERR_OOM;
    }

    int rc = HWH_OK;
    uint64_t total = 0;
    for (;;) {
        ssize_t n = read(src_fd, buf, COPY_CHUNK_SIZE);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            fprintf(stderr, "copy read failed: %s\n", strerror(errno));
            rc = HWH_ERR_DB_READ_FAILED;
            break;
        }
        if (n == 0) {
            break;
        }
        if (total < HWH_PAGE_SIZE) {
            size_t need = HWH_PAGE_SIZE - (size_t)total;
            size_t copy_n = (size_t)n < need ? (size_t)n : need;
            memcpy(page1_out + total, buf, copy_n);
        }
        if (write_all_fd(dst_fd, buf, (size_t)n) != 0) {
            fprintf(stderr, "copy write failed: %s\n", strerror(errno));
            rc = HWH_ERR_DB_READ_FAILED;
            break;
        }
        total += (uint64_t)n;
    }

    if (rc == HWH_OK) {
        (void)fsync(dst_fd);
    }
    secure_zero(buf, COPY_CHUNK_SIZE);
    free(buf);
    close(src_fd);
    close(dst_fd);
    *bytes_out = total;
    return rc;
}

static const char *err_code_str(int rc) {
    switch (rc) {
        case HWH_ERR_DB_NOT_FOUND: return "DB_NOT_FOUND";
        case HWH_ERR_DB_NO_ACCESS: return "DB_NO_ACCESS";
        case HWH_ERR_DB_READ_FAILED: return "DB_READ_FAILED";
        case HWH_ERR_DB_TOO_SMALL: return "DB_TOO_SMALL";
        case HWH_ERR_NO_DAEMON: return "NO_DAEMON";
        case HWH_ERR_NO_LIBSQLCIPHER: return "NO_LIBSQLCIPHER";
        case HWH_ERR_NO_SALT: return "NO_SALT";
        case HWH_ERR_NO_CTX: return "NO_CTX";
        case HWH_ERR_UNMASK_FAILED: return "UNMASK_FAILED";
        case HWH_ERR_MEM_NO_ACCESS: return "MEM_NO_ACCESS";
        case HWH_ERR_DST_OPEN_FAILED: return "DST_OPEN_FAILED";
        default: return "INTERNAL";
    }
}

#ifndef HWH_NO_MAIN
static void enter_global_mnt_ns_if_needed(const char *src_path) {
    if (access(src_path, R_OK) == 0 || errno != ENOENT) {
        return;
    }
    int ns_fd = open("/proc/1/ns/mnt", O_RDONLY);
    if (ns_fd >= 0) {
        (void)setns(ns_fd, CLONE_NEWNS);
        close(ns_fd);
    }
}

int main(int argc, char **argv) {
    const char *src_path = NULL;
    const char *dst_path = NULL;
    const char *custom_proc = NULL;
    const char *if_changed_meta = NULL;
    int force_recover = 0;
    int snapshot_only = 0;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--force-recover") == 0) {
            force_recover = 1;
        } else if (strcmp(argv[i], "--snapshot-only") == 0) {
            snapshot_only = 1;
        } else if (strcmp(argv[i], "--process") == 0 && i + 1 < argc) {
            custom_proc = argv[++i];
        } else if (strcmp(argv[i], "--if-changed") == 0 && i + 1 < argc) {
            if_changed_meta = argv[++i];
        } else if (argv[i][0] == '-') {
            fprintf(stderr, "Unknown option: %s\n", argv[i]);
            return HWH_ERR_ARGS;
        } else if (!src_path) {
            src_path = argv[i];
        } else if (!dst_path) {
            dst_path = argv[i];
        } else {
            fprintf(stderr, "Unexpected argument: %s\n", argv[i]);
            return HWH_ERR_ARGS;
        }
    }

    if (!src_path || !dst_path) {
        fprintf(stderr, "Usage: %s <src_db> <dst_snapshot> [--force-recover] [--process <name>] [--if-changed <meta>]\n", argv[0]);
        return HWH_ERR_ARGS;
    }

    /* Read optional cached hex key line from stdin (never passed via argv; stop at newline). */
    char stdin_buf[128];
    memset(stdin_buf, 0, sizeof(stdin_buf));
    {
        size_t pos = 0;
        while (pos < sizeof(stdin_buf) - 1U) {
            ssize_t r = read(STDIN_FILENO, stdin_buf + pos, sizeof(stdin_buf) - 1U - pos);
            if (r < 0) {
                if (errno == EINTR) {
                    continue;
                }
                break;
            }
            if (r == 0) {
                break;
            }
            void *nl = memchr(stdin_buf + pos, '\n', (size_t)r);
            pos += (size_t)r;
            if (nl != NULL) {
                break;
            }
        }
        stdin_buf[pos] = '\0';
    }

    char *trimmed = stdin_buf;
    while (*trimmed && isspace((unsigned char)*trimmed)) {
        trimmed++;
    }
    size_t tlen = strlen(trimmed);
    while (tlen > 0 && isspace((unsigned char)trimmed[tlen - 1U])) {
        trimmed[--tlen] = '\0';
    }

    uint8_t page1[HWH_PAGE_SIZE];
    memset(page1, 0, sizeof(page1));
    uint64_t total_bytes = 0;

    enter_global_mnt_ns_if_needed(src_path);
    {
        struct stat st;
        if (stat(src_path, &st) == 0) {
            char cur_meta[64];
            snprintf(
                cur_meta,
                sizeof(cur_meta),
                "%lld:%ld:%lld",
                (long long)st.st_mtim.tv_sec,
                (long)st.st_mtim.tv_nsec,
                (long long)st.st_size
            );
            printf("STATUS:DB_META:%s\n", cur_meta);
            fflush(stdout);
            if (if_changed_meta != NULL && strcmp(cur_meta, if_changed_meta) == 0) {
                printf("RESULT:UNCHANGED\n");
                fflush(stdout);
                secure_zero(stdin_buf, sizeof(stdin_buf));
                return HWH_OK;
            }
        }
    }
    int rc = copy_snapshot(src_path, dst_path, page1, &total_bytes);
    if (rc != HWH_OK) {
        if (rc == HWH_ERR_DB_NO_ACCESS) {
            printf("ERR:DB_NO_ACCESS\n");
        } else {
            printf("ERR:%s\n", err_code_str(rc));
        }
        fflush(stdout);
        secure_zero(stdin_buf, sizeof(stdin_buf));
        secure_zero(page1, sizeof(page1));
        return rc;
    }

    printf("STATUS:COPY_DONE:%llu\n", (unsigned long long)total_bytes);
    fflush(stdout);

    if (snapshot_only) {
        secure_zero(stdin_buf, sizeof(stdin_buf));
        secure_zero(page1, sizeof(page1));
        return HWH_OK;
    }

    if (total_bytes < HWH_PAGE_SIZE) {
        printf("ERR:DB_TOO_SMALL\n");
        fflush(stdout);
        secure_zero(stdin_buf, sizeof(stdin_buf));
        secure_zero(page1, sizeof(page1));
        return HWH_ERR_DB_TOO_SMALL;
    }

    if (memcmp(page1, SQLITE_HEADER, sizeof(SQLITE_HEADER)) == 0) {
        printf("RESULT:PLAIN\n");
        fflush(stdout);
        secure_zero(stdin_buf, sizeof(stdin_buf));
        secure_zero(page1, sizeof(page1));
        return HWH_OK;
    }

    if (!force_recover && tlen > 0) {
        uint8_t cached_key[HWH_KEY_SIZE];
        uint8_t hmac_key[HWH_KEY_SIZE];
        int valid = 0;
        if (parse_hex_32(trimmed, cached_key) == 0) {
            derive_hmac_key(cached_key, page1, hmac_key);
            valid = verify_page1_hmac(page1, hmac_key);
        }
        secure_zero(cached_key, sizeof(cached_key));
        secure_zero(hmac_key, sizeof(hmac_key));

        if (valid) {
            printf("RESULT:CACHED_OK\n");
            fflush(stdout);
            secure_zero(stdin_buf, sizeof(stdin_buf));
            secure_zero(page1, sizeof(page1));
            return HWH_OK;
        }
        printf("STATUS:CACHED_KEY_INVALID\n");
        fflush(stdout);
    }
    secure_zero(stdin_buf, sizeof(stdin_buf));

    printf("STATUS:RECOVERING_KEY\n");
    fflush(stdout);

    uint8_t rk[HWH_KEY_SIZE];
    uint8_t hk[HWH_KEY_SIZE];
    if (custom_proc) {
        rc = recover_key_from_process(custom_proc, page1, rk, hk);
    } else {
        rc = recover_key_from_process(DEFAULT_PROCESS_PRIMARY, page1, rk, hk);
        if (rc == HWH_ERR_NO_DAEMON || rc == HWH_ERR_NO_LIBSQLCIPHER || rc == HWH_ERR_NO_SALT) {
            int fb_rc = recover_key_from_process(DEFAULT_PROCESS_FALLBACK, page1, rk, hk);
            if (fb_rc == HWH_OK) {
                rc = HWH_OK;
            } else if (rc == HWH_ERR_NO_DAEMON) {
                rc = fb_rc;
            }
        }
    }

    if (rc == HWH_OK) {
        char hex_out[65];
        format_hex_32(rk, hex_out);
        printf("RESULT:KEY:%s\n", hex_out);
        fflush(stdout);
        secure_zero(hex_out, sizeof(hex_out));
    } else {
        printf("ERR:%s\n", err_code_str(rc));
        fflush(stdout);
    }

    secure_zero(rk, sizeof(rk));
    secure_zero(hk, sizeof(hk));
    secure_zero(page1, sizeof(page1));
    return rc;
}
#endif
