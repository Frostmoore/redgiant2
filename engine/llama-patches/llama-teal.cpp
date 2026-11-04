// RedGiant (G27, 2026-11-04): activation sparsity for the weights that stay in RAM.
//
// When a dense model does not fit in the graphics card, most of each token's time goes into
// reading the layers kept in RAM. TEAL-style sparsity sets to zero the inputs of a matrix
// product below c times the token's mean magnitude; the weights those zeros multiply need not
// be read. In llama.cpp's layout (rows of the output, blocks along the input) a block is
// almost never all zero, so the RAM layers get a second copy stored by columns: one row of
// W^T per input, 4-bit blocks of 32 along the output. Writing one token at a time reads only
// the columns of the inputs that are not zero (1.28x at 25 %, 1.52x at 40 % measured on a
// Ryzen 9 9900X); reading a context keeps the original weights.
//
//   LLAMA_TEAL_C=c     the threshold (0.27, 0.40, 0.50 give about 25, 33, 40 %); unset = off
//   LLAMA_TEAL_DIR=d   where the copies are kept (made once, then mapped): a writable folder
//
// The copy of a model is one file, <dir>/<model name>.<size>.teal, checked by the model's size
// and each tensor's shape.

#include "llama-teal.h"

#include "ggml-backend.h"

#include "llama-impl.h"
#include "llama-mmap.h"
#include "llama-model.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <chrono>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if defined(__x86_64__) || defined(_M_X64)
#include <immintrin.h>
#define TEAL_X86 1
#if defined(_MSC_VER)
#include <intrin.h>
#define TEAL_AVX2_FN
#else
#include <cpuid.h>
#define TEAL_AVX2_FN __attribute__((target("avx2,fma,f16c")))
#endif
#endif

#ifndef TEAL_GROUP
#define TEAL_GROUP 8
#endif

namespace {

struct teal_block {   // 32 weights: a half-precision scale and 16 bytes of 4-bit values (-8..7)
    ggml_fp16_t d;
    uint8_t     q[16];
};
static_assert(sizeof(teal_block) == 18, "teal_block must be packed in 18 bytes (4.5 bits a weight)");

// One weight's copy by columns: K rows (one per input) of N/32 blocks.
struct teal_matrix {
    const teal_block * data = nullptr;
    int64_t K = 0;
    int64_t N = 0;
    int     parts = 1;   // slices of the inputs: one partial sum each
    int     slices = 1;  // slices of the output (each long enough to be read contiguously)
    float   c = 0.0f;
};

struct teal_state {
    std::mutex mutex;
    bool tried = false;
    std::unique_ptr<llama_file> file;
    std::unique_ptr<llama_mmap> map;
    std::vector<char> owned;
    std::map<const ggml_tensor *, teal_matrix> matrices;
};

teal_state & state() {
    static teal_state s;
    return s;
}

float env_c() {
    static const float c = [] {
        const char * e = getenv("LLAMA_TEAL_C");
        return e ? (float) atof(e) : -1.0f;
    }();
    return c;
}

bool has_avx2() {
#if defined(TEAL_X86)
#if defined(_MSC_VER)
    int r[4];
    __cpuidex(r, 7, 0);
    const bool avx2 = (r[1] & (1 << 5)) != 0;
    __cpuid(r, 1);
    const bool fma = (r[2] & (1 << 12)) != 0;
    const bool f16c = (r[2] & (1 << 29)) != 0;
    return avx2 && fma && f16c;
#else
    return __builtin_cpu_supports("avx2") && __builtin_cpu_supports("fma") && __builtin_cpu_supports("f16c");
#endif
#else
    return false;
#endif
}

bool is_teal_weight(const ggml_tensor * w) {
    if (strncmp(w->name, "blk.", 4) != 0 || ggml_n_dims(w) != 2) return false;
    if (w->ne[1] % 32 != 0) return false;
    // Weights not loaded yet (the contexts --fit makes to measure memory) are not ready.
    if (w->data == nullptr || w->buffer == nullptr || !ggml_backend_buffer_is_host(w->buffer)) return false;
    const char * names[] = { "attn_q.weight", "attn_k.weight", "attn_v.weight", "attn_output.weight",
                             "attn_qkv.weight", "ffn_gate.weight", "ffn_up.weight", "ffn_down.weight" };
    for (const char * n : names) {
        const size_t ln = strlen(n), lw = strlen(w->name);
        if (lw > ln && strcmp(w->name + lw - ln, n) == 0) return true;
    }
    return false;
}

void quantize_block(const float * v, teal_block & b) {
    float amax = 0.0f, max = 0.0f;
    for (int i = 0; i < 32; i++) {
        if (fabsf(v[i]) > amax) { amax = fabsf(v[i]); max = v[i]; }
    }
    const float d = max / -8.0f;
    const float id = d != 0.0f ? 1.0f / d : 0.0f;
    b.d = ggml_fp32_to_fp16(d);
    for (int i = 0; i < 16; i++) {
        const int lo = std::min(15, std::max(0, (int) lrintf(v[i] * id) + 8));
        const int hi = std::min(15, std::max(0, (int) lrintf(v[i + 16] * id) + 8));
        b.q[i] = (uint8_t) (lo | (hi << 4));
    }
}

// W (rows of K inputs, N rows) to W^T by columns, 4-bit: bands of 32 outputs, in parallel.
void make_copy(const ggml_tensor * w, teal_block * out) {
    const int64_t K = w->ne[0], N = w->ne[1], nb = N / 32;
    const auto * traits = ggml_get_type_traits(w->type);
    const int nt = std::max(1u, std::min(16u, std::thread::hardware_concurrency()));
    std::atomic<int64_t> next{0};
    auto work = [&] {
        std::vector<float> band((size_t) 32 * K);
        float col[32];
        for (int64_t b; (b = next.fetch_add(1)) < nb; ) {
            for (int i = 0; i < 32; i++) {
                const char * row = (const char *) w->data + (size_t) (b * 32 + i) * w->nb[1];
                if (w->type == GGML_TYPE_F32) memcpy(&band[(size_t) i * K], row, K * sizeof(float));
                else traits->to_float(row, &band[(size_t) i * K], K);
            }
            for (int64_t k = 0; k < K; k++) {
                for (int i = 0; i < 32; i++) col[i] = band[(size_t) i * K + k];
                quantize_block(col, out[(size_t) k * nb + b]);
            }
        }
    };
    std::vector<std::thread> threads;
    for (int t = 0; t < nt; t++) threads.emplace_back(work);
    for (auto & t : threads) t.join();
}

// The 16 values of one half of a block, as two groups of 8 floats (scalar code in the fallback).
#if defined(TEAL_X86)
TEAL_AVX2_FN inline void half16(const teal_block & b, int half, __m256 & lo, __m256 & hi) {
    __m128i raw = _mm_loadu_si128((const __m128i *) b.q);
    __m128i nib = half == 0 ? _mm_and_si128(raw, _mm_set1_epi8(0x0f))
                            : _mm_and_si128(_mm_srli_epi16(raw, 4), _mm_set1_epi8(0x0f));
    nib = _mm_sub_epi8(nib, _mm_set1_epi8(8));
    lo = _mm256_cvtepi32_ps(_mm256_cvtepi8_epi32(nib));
    hi = _mm256_cvtepi32_ps(_mm256_cvtepi8_epi32(_mm_srli_si128(nib, 8)));
}

// acc[N] += sum over G columns of x_k * W^T[k]: the partial sums loaded and stored once for G
// columns (with 4 the traffic of the partial sums outweighed the weights' on the FFN's outputs).
template <int G>
TEAL_AVX2_FN void axpyG_avx2(const teal_block * const r[G], const float xs_[G], int64_t nb, float * acc) {
    __m256 xs[G];
    for (int c = 0; c < G; c++) xs[c] = _mm256_set1_ps(xs_[c]);
    for (int64_t b = 0; b < nb; b++) {
        float * o = acc + b * 32;
        __m256 o0 = _mm256_loadu_ps(o), o1 = _mm256_loadu_ps(o + 8);
        __m256 o2 = _mm256_loadu_ps(o + 16), o3 = _mm256_loadu_ps(o + 24);
        for (int c = 0; c < G; c++) {
            // The scale converted in a register (F16C), not by a call into ggml at every block.
            const __m256 s = _mm256_mul_ps(_mm256_cvtph_ps(_mm_set1_epi16((short) r[c][b].d)), xs[c]);
            __m256 a0, a1, c0, c1;
            half16(r[c][b], 0, a0, a1);
            half16(r[c][b], 1, c0, c1);
            o0 = _mm256_fmadd_ps(a0, s, o0);
            o1 = _mm256_fmadd_ps(a1, s, o1);
            o2 = _mm256_fmadd_ps(c0, s, o2);
            o3 = _mm256_fmadd_ps(c1, s, o3);
        }
        _mm256_storeu_ps(o, o0);
        _mm256_storeu_ps(o + 8, o1);
        _mm256_storeu_ps(o + 16, o2);
        _mm256_storeu_ps(o + 24, o3);
    }
}
#endif

void axpy_scalar(const teal_block * r, float x, int64_t nb, float * acc) {
    for (int64_t b = 0; b < nb; b++) {
        const float s = ggml_fp16_to_fp32(r[b].d) * x;
        float * o = acc + b * 32;
        for (int i = 0; i < 16; i++) {
            o[i]      += (float) ((int) (r[b].q[i] & 0x0f) - 8) * s;
            o[i + 16] += (float) ((int) (r[b].q[i] >> 4) - 8) * s;
        }
    }
}

// LLAMA_TEAL_STATS=1: how fast the sparse products read, printed now and then (measuring only).
struct teal_stats {
    std::atomic<int64_t> start{0}, end{0}, ns{0}, bytes{0}, calls{0};
};
teal_stats & stats() {
    static teal_stats s;
    return s;
}
bool stats_on() {
    static const bool on = getenv("LLAMA_TEAL_STATS") != nullptr;
    return on;
}
int64_t now_ns() {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

// First operation: each part (a slice of the inputs) sums the columns of its non-zero inputs
// into its own column of dst [N, parts]. Threads take parts in turn.
void op_partial(ggml_tensor * dst, int ith, int nth, void * userdata) {
    const auto * m = (const teal_matrix *) userdata;
    const ggml_tensor * xt = dst->src[0];
    const float * x = (const float *) xt->data;
    const int64_t K = m->K, N = m->N, nb = N / 32;
    // The threshold from the whole input (each thread computes it: a few microseconds).
    double sum = 0.0;
    for (int64_t k = 0; k < K; k++) sum += fabsf(x[k]);
    const float cut = m->c * (float) (sum / (double) K);
    static const bool avx2 = has_avx2();
    if (stats_on() && ith == 0) stats().start = now_ns();
    int64_t used = 0;
    // Tasks = slices of the inputs x slices of the output: few partial sums to add, and each
    // column still read in runs of a few KB.
    const int tasks = m->parts * m->slices;
    for (int task = ith; task < tasks; task += nth) {
        const int p = task / m->slices, q = task % m->slices;
        const int64_t bq0 = nb * q / m->slices, bq1 = nb * (q + 1) / m->slices;
        float * acc = (float *) ((char *) dst->data + (size_t) p * dst->nb[1]) + bq0 * 32;
        memset(acc, 0, (size_t) (bq1 - bq0) * 32 * sizeof(float));
        const int64_t k0 = K * p / m->parts, k1 = K * (p + 1) / m->parts;
        constexpr int G = TEAL_GROUP;
        int64_t ks[G];
        int n = 0;
        for (int64_t k = k0; k < k1; k++) {
            if (fabsf(x[k]) < cut || x[k] == 0.0f) continue;
            ks[n++] = k;
            if (n == G) {
#if defined(TEAL_X86)
                if (avx2) {
                    const teal_block * r[G];
                    float xs[G];
                    for (int c = 0; c < G; c++) { r[c] = m->data + ks[c] * nb + bq0; xs[c] = x[ks[c]]; }
                    axpyG_avx2<G>(r, xs, bq1 - bq0, acc);
                    n = 0;
                    continue;
                }
#endif
                for (int c = 0; c < G; c++) axpy_scalar(m->data + ks[c] * nb + bq0, x[ks[c]], bq1 - bq0, acc);
                n = 0;
            }
        }
        for (int c = 0; c < n; c++) axpy_scalar(m->data + ks[c] * nb + bq0, x[ks[c]], bq1 - bq0, acc);
        if (stats_on() && q == 0) {
            for (int64_t k = k0; k < k1; k++) used += (fabsf(x[k]) >= cut && x[k] != 0.0f);
        }
    }
    if (stats_on()) {
        stats().bytes += used * nb * (int64_t) sizeof(teal_block);
        int64_t t = now_ns(), e = stats().end.load();
        while (t > e && !stats().end.compare_exchange_weak(e, t)) {}
    }
}

// Second operation: the parts added, each thread a slice of the output.
void op_sum(ggml_tensor * dst, int ith, int nth, void * userdata) {
    const auto * m = (const teal_matrix *) userdata;
    const ggml_tensor * parts = dst->src[0];
    float * y = (float *) dst->data;
    const int64_t N = m->N;
    if (stats_on() && ith == 0) {
        auto & st = stats();
        st.ns += st.end.load() - st.start.load();
        if (++st.calls % 2000 == 0) {
            fprintf(stderr, "teal: %lld products, %.1f GB read at %.1f GB/s inside the products, %.1f ms\n",
                    (long long) st.calls.load(), st.bytes.load() / 1e9, st.bytes.load() / (double) st.ns.load(), st.ns.load() / 1e6);
            fflush(stderr);
        }
    }
    const int64_t j0 = N * ith / nth, j1 = N * (ith + 1) / nth;
    for (int64_t j = j0; j < j1; j++) {
        float v = 0.0f;
        for (int p = 0; p < m->parts; p++) v += ((const float *) ((const char *) parts->data + (size_t) p * parts->nb[1]))[j];
        y[j] = v;
    }
}

struct file_entry {
    char    name[64];
    int64_t K, N;
    int64_t offset;
};

// The copies of every RAM weight of the model, made once into one file and then mapped.
void prepare(const llama_model & model, int n_threads) {
    auto & s = state();
    std::vector<const ggml_tensor *> ws;
    for (const auto & [name, t] : model.tensors_by_name) {
        if (is_teal_weight(t)) ws.push_back(t);
    }
    // Nothing loaded in RAM yet (a context made only to measure memory): the real one prepares.
    if (ws.empty()) return;
    s.tried = true;
    const char * dir = getenv("LLAMA_TEAL_DIR");
    std::string base = dir ? std::string(dir) : std::string(".");
    // The model's name and size in the copy's name: another model never matches.
    size_t total_model = 0;
    for (const auto & [name, t] : model.tensors_by_name) total_model += ggml_nbytes(t);
    char fname[512];
    snprintf(fname, sizeof(fname), "%s/%s.%zu.teal", base.c_str(), model.name.empty() ? "model" : model.name.c_str(), total_model);
    for (char * c = fname + base.size() + 1; *c; c++) {
        if (*c == '/' || *c == '\\' || *c == ':' || *c == ' ') *c = '_';
    }
    std::vector<file_entry> entries;
    int64_t offset = 0;
    for (const auto * t : ws) {
        file_entry e{};
        snprintf(e.name, sizeof(e.name), "%s", t->name);
        e.K = t->ne[0];
        e.N = t->ne[1];
        offset = (offset + 63) / 64 * 64;
        e.offset = offset;
        offset += e.K * (e.N / 32) * (int64_t) sizeof(teal_block);
        entries.push_back(e);
    }
    const int64_t header = 64 + (int64_t) entries.size() * (int64_t) sizeof(file_entry);
    const int64_t data0 = (header + 4095) / 4096 * 4096;
    const int64_t total = data0 + offset;

    bool ok = false;
    {
        FILE * f = fopen(fname, "rb");
        if (f) {
            char magic[8] = {0};
            int64_t count = 0;
            ok = fread(magic, 1, 8, f) == 8 && memcmp(magic, "RGTEAL02", 8) == 0 &&
                 fread(&count, sizeof(count), 1, f) == 1 && count == (int64_t) entries.size();
            if (ok) {
                fseek(f, 64, SEEK_SET);
                for (const auto & e : entries) {
                    file_entry r{};
                    if (fread(&r, sizeof(r), 1, f) != 1 || memcmp(&r, &e, sizeof(r)) != 0) { ok = false; break; }
                }
            }
            fseek(f, 0, SEEK_END);
            ok = ok && (int64_t) ftell(f) == total;
            fclose(f);
        }
    }
    if (!ok) {
        LLAMA_LOG_INFO("%s: preparing %zu weights by columns into %s (%.1f GB, once)\n", __func__, ws.size(), fname, total / 1e9);
        const std::string tmp = std::string(fname) + ".part";
        FILE * f = fopen(tmp.c_str(), "wb");
        if (!f) {
            LLAMA_LOG_WARN("%s: cannot write %s: sparsity stays off\n", __func__, tmp.c_str());
            return;
        }
        std::vector<char> head((size_t) data0, 0);
        memcpy(head.data(), "RGTEAL02", 8);
        const int64_t count = (int64_t) entries.size();
        memcpy(head.data() + 8, &count, sizeof(count));
        memcpy(head.data() + 64, entries.data(), entries.size() * sizeof(file_entry));
        fwrite(head.data(), 1, head.size(), f);
        int64_t written = 0;
        std::vector<char> zeros(64, 0);
        for (size_t i = 0; i < ws.size(); i++) {
            const auto & e = entries[i];
            if (e.offset > written) { fwrite(zeros.data(), 1, (size_t) (e.offset - written), f); written = e.offset; }
            std::vector<teal_block> buf((size_t) (e.K * (e.N / 32)));
            make_copy(ws[i], buf.data());
            fwrite(buf.data(), sizeof(teal_block), buf.size(), f);
            written += (int64_t) (buf.size() * sizeof(teal_block));
            LLAMA_LOG_INFO("%s: %zu/%zu %s\n", __func__, i + 1, ws.size(), e.name);
        }
        fclose(f);
        std::remove(fname);
        if (std::rename(tmp.c_str(), fname) != 0) {
            LLAMA_LOG_WARN("%s: cannot rename %s: sparsity stays off\n", __func__, tmp.c_str());
            return;
        }
    }
    s.file = std::make_unique<llama_file>(fname, "rb");
    const char * base_addr = nullptr;
    if (getenv("LLAMA_TEAL_LOAD")) {
        // Read into the process's memory instead of mapped (measuring Windows' page handling).
        s.owned.resize((size_t) total);
        s.file->seek(0, SEEK_SET);
        s.file->read_raw(s.owned.data(), (size_t) total);
        base_addr = s.owned.data();
    } else {
        s.map = std::make_unique<llama_mmap>(s.file.get(), 0);
        base_addr = (const char *) s.map->addr();
    }
    for (size_t i = 0; i < ws.size(); i++) {
        teal_matrix m;
        m.data  = (const teal_block *) (base_addr + data0 + entries[i].offset);
        m.K     = entries[i].K;
        m.N     = entries[i].N;
        // Output slices of at least 4096 values (runs of 2.3 KB per column), a divisor of the threads.
        const int nt = std::max(1, n_threads);
        int slices = 1;
        for (int d = 1; d <= nt; d++) {
            if (nt % d == 0 && entries[i].N / d >= 4096) slices = d;
        }
        if (getenv("LLAMA_TEAL_SLICES")) slices = std::max(1, atoi(getenv("LLAMA_TEAL_SLICES")));
        if (nt % slices != 0) slices = 1;
        m.slices = slices;
        m.parts  = nt / slices;
        m.c     = env_c();
        s.matrices[ws[i]] = m;
    }
    LLAMA_LOG_INFO("%s: sparsity on for %zu weights in RAM, c = %.2f\n", __func__, ws.size(), env_c());
}

} // namespace

void llama_teal_init(const llama_model & model, int n_threads) {
    if (env_c() < 0.0f) return;
    auto & s = state();
    std::lock_guard<std::mutex> lock(s.mutex);
    if (!s.tried) prepare(model, n_threads);
}

ggml_tensor * llama_teal_mul_mat(ggml_context * ctx, ggml_tensor * w, ggml_tensor * cur) {
    if (env_c() < 0.0f) return nullptr;
    // One token at a time only: reading a context keeps the original weights.
    if (cur->type != GGML_TYPE_F32 || cur->ne[1] != 1 || cur->ne[2] != 1 || cur->ne[3] != 1) return nullptr;
    auto & s = state();
    teal_matrix * m = nullptr;
    {
        std::lock_guard<std::mutex> lock(s.mutex);
        auto it = s.matrices.find(w);
        if (it == s.matrices.end()) return nullptr;
        m = &it->second;
    }
    ggml_tensor * x = ggml_is_contiguous(cur) ? cur : ggml_cont(ctx, cur);
    ggml_tensor * args1[] = { x };
    ggml_tensor * parts = ggml_custom_4d(ctx, GGML_TYPE_F32, m->N, m->parts, 1, 1, args1, 1, op_partial, GGML_N_TASKS_MAX, m);
    ggml_tensor * args2[] = { parts };
    return ggml_custom_4d(ctx, GGML_TYPE_F32, m->N, 1, 1, 1, args2, 1, op_sum, GGML_N_TASKS_MAX, m);
}
