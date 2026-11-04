// Does skipping weights pay on this CPU? (RedGiant G26.6, 2026-11-04)
//
// A dense model outside the card spends most of each token reading its weights from RAM. With
// TEAL-style sparsity a fraction of each layer's input is zero, and the weights those zeros
// multiply need not be read, but only if they lie together: in llama.cpp's layout (rows of
// the output, blocks of 32 along the input) a 32-block is almost never all zero. Stored by
// columns instead (one row of W^T per input), every zero input skips a whole row.
//
// This compares, on Llama 3.3 70B's matrix shapes, 4-bit weights (Q4_0-like: 32 values, one
// scale) read
//   dense:  row-major, every weight, one dot product per output;
//   sparse: column-major, only the rows of the inputs that are not zero, axpy into the output.
// Both multithreaded, AVX2. Prints milliseconds per token and GB/s.
//
// Build (Windows): cl /O2 /arch:AVX2 /openmp /EHsc sparse_matvec.cpp
#include <immintrin.h>
#include <omp.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <vector>

struct Block {          // 32 weights: a float scale, 16 bytes of 4-bit values (-8..7)
    float d;
    uint8_t q[16];
};

// The 16 values of one half as two groups of 8 floats.
static inline void half16(const Block & b, int half, __m256 & lo, __m256 & hi) {
    __m128i raw = _mm_loadu_si128((const __m128i *) b.q);
    __m128i nib = half == 0 ? _mm_and_si128(raw, _mm_set1_epi8(0x0f))
                            : _mm_and_si128(_mm_srli_epi16(raw, 4), _mm_set1_epi8(0x0f));
    nib = _mm_sub_epi8(nib, _mm_set1_epi8(8));
    lo = _mm256_cvtepi32_ps(_mm256_cvtepi8_epi32(nib));
    hi = _mm256_cvtepi32_ps(_mm256_cvtepi8_epi32(_mm_srli_si128(nib, 8)));
}

static std::vector<Block> random_blocks(size_t n, uint32_t seed) {
    std::vector<Block> v(n);
    std::mt19937 rng(seed);
    for (auto & b : v) {
        b.d = 0.01f + (rng() % 100) * 1e-4f;
        for (auto & q : b.q) q = (uint8_t) rng();
    }
    return v;
}

// y[out] = sum_k W[out][k] * x[k], W row-major: rows of K/32 blocks.
static void dense(const std::vector<Block> & w, int K, int N, const float * x, float * y) {
    const int kb = K / 32;
#pragma omp parallel for schedule(static)
    for (int r = 0; r < N; r++) {
        const Block * row = &w[(size_t) r * kb];
        __m256 acc = _mm256_setzero_ps();
        for (int b = 0; b < kb; b++) {
            __m256 s = _mm256_set1_ps(row[b].d);
            __m256 a0, a1, b0, b1;
            half16(row[b], 0, a0, a1);
            half16(row[b], 1, b0, b1);
            const float * xb = x + b * 32;
            acc = _mm256_fmadd_ps(_mm256_mul_ps(a0, s), _mm256_loadu_ps(xb), acc);
            acc = _mm256_fmadd_ps(_mm256_mul_ps(a1, s), _mm256_loadu_ps(xb + 8), acc);
            acc = _mm256_fmadd_ps(_mm256_mul_ps(b0, s), _mm256_loadu_ps(xb + 16), acc);
            acc = _mm256_fmadd_ps(_mm256_mul_ps(b1, s), _mm256_loadu_ps(xb + 24), acc);
        }
        __m128 h = _mm_add_ps(_mm256_castps256_ps128(acc), _mm256_extractf128_ps(acc, 1));
        h = _mm_hadd_ps(h, h);
        h = _mm_hadd_ps(h, h);
        y[r] = _mm_cvtss_f32(h);
    }
}

// The same product with W^T: one row of N/32 blocks per input; only the inputs that are not zero.
// Each thread takes a share of the non-zero inputs and reads their rows whole (long contiguous
// reads, what RAM serves best), summing into its own copy of the output; the copies are added
// at the end (a few MB against hundreds of MB of weights).
static void sparse(const std::vector<Block> & wt, int K, int N, const float * x,
                   const std::vector<int> & nz, float * y) {
    (void) K;
    const int nb = N / 32;
    static std::vector<std::vector<float>> parts;
    const int nt = omp_get_max_threads();
    if ((int) parts.size() < nt) parts.resize(nt);
#pragma omp parallel
    {
        const int t = omp_get_thread_num(), n = omp_get_num_threads();
        auto & acc = parts[t];
        acc.assign((size_t) N, 0.0f);
        const size_t i0 = nz.size() * t / n, i1 = nz.size() * (t + 1) / n;
        size_t i = i0;
        for (; i + 4 <= i1; i += 4) {
            const Block * r[4];
            __m256 xs[4];
            for (int c = 0; c < 4; c++) {
                r[c] = &wt[(size_t) nz[i + c] * nb];
                xs[c] = _mm256_set1_ps(x[nz[i + c]]);
            }
            for (int b = 0; b < nb; b++) {
                float * o = &acc[(size_t) b * 32];
                __m256 o0 = _mm256_loadu_ps(o), o1 = _mm256_loadu_ps(o + 8);
                __m256 o2 = _mm256_loadu_ps(o + 16), o3 = _mm256_loadu_ps(o + 24);
                for (int c = 0; c < 4; c++) {
                    __m256 s = _mm256_mul_ps(_mm256_set1_ps(r[c][b].d), xs[c]);
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
        for (; i < i1; i++) {
            const Block * row = &wt[(size_t) nz[i] * nb];
            const __m256 xs = _mm256_set1_ps(x[nz[i]]);
            for (int b = 0; b < nb; b++) {
                __m256 s = _mm256_mul_ps(_mm256_set1_ps(row[b].d), xs);
                __m256 a0, a1, c0, c1;
                half16(row[b], 0, a0, a1);
                half16(row[b], 1, c0, c1);
                float * o = &acc[(size_t) b * 32];
                _mm256_storeu_ps(o, _mm256_fmadd_ps(a0, s, _mm256_loadu_ps(o)));
                _mm256_storeu_ps(o + 8, _mm256_fmadd_ps(a1, s, _mm256_loadu_ps(o + 8)));
                _mm256_storeu_ps(o + 16, _mm256_fmadd_ps(c0, s, _mm256_loadu_ps(o + 16)));
                _mm256_storeu_ps(o + 24, _mm256_fmadd_ps(c1, s, _mm256_loadu_ps(o + 24)));
            }
        }
#pragma omp barrier
        // The copies added: each thread a slice of the output.
        const int j0 = (int) ((int64_t) N * t / n), j1 = (int) ((int64_t) N * (t + 1) / n);
        for (int j = j0; j < j1; j++) {
            float v = 0.0f;
            for (int p = 0; p < n; p++) v += parts[p][j];
            y[j] = v;
        }
    }
}

int main(int argc, char ** argv) {
    // One Llama 3.3 70B layer: q (8192x8192), k and v (1024x8192), o (8192x8192),
    // gate and up (28672x8192), down (8192x28672). Several layers, so nothing stays in cache.
    const int layers = argc > 1 ? atoi(argv[1]) : 6;
    struct Shape { int N, K; };
    const Shape shapes[] = { {8192, 8192}, {1024, 8192}, {1024, 8192}, {8192, 8192},
                             {28672, 8192}, {28672, 8192}, {8192, 28672} };
    struct Mat { int N, K; std::vector<Block> w, wt; };
    std::vector<Mat> mats;
    double gb = 0;
    for (int l = 0; l < layers; l++)
        for (const auto & s : shapes) {
            Mat m{s.N, s.K, random_blocks((size_t) s.N * s.K / 32, 1 + (uint32_t) mats.size()), {}};
            m.wt = random_blocks((size_t) s.N * s.K / 32, 1000 + (uint32_t) mats.size());
            gb += (double) s.N * s.K / 32 * sizeof(Block) / 1e9;
            mats.push_back(std::move(m));
        }
    printf("{\"layers\":%d,\"gb_per_token\":%.2f,\"threads\":%d}\n", layers, gb, omp_get_max_threads());
    std::mt19937 rng(42);
    std::normal_distribution<float> g(0.0f, 1.0f);
    std::vector<float> x(28672), y(28672);
    for (auto & v : x) v = g(rng);

    auto timeit = [&](auto && f) {
        f();  // once to warm up
        const int reps = 5;
        auto t0 = std::chrono::steady_clock::now();
        for (int i = 0; i < reps; i++) f();
        auto t1 = std::chrono::steady_clock::now();
        return std::chrono::duration<double, std::milli>(t1 - t0).count() / reps;
    };
    const double dense_ms = timeit([&] { for (auto & m : mats) dense(m.w, m.K, m.N, x.data(), y.data()); });
    printf("{\"kind\":\"dense\",\"sparsity\":0,\"ms\":%.1f,\"gbs\":%.1f}\n", dense_ms, gb / dense_ms * 1000);
    for (double s : {0.0, 0.25, 0.40, 0.50}) {
        // The zero inputs at random positions, as TEAL's thresholds leave them.
        std::vector<std::vector<int>> nzs;
        for (auto & m : mats) {
            std::vector<int> nz;
            std::uniform_real_distribution<double> u(0, 1);
            for (int k = 0; k < m.K; k++) if (u(rng) >= s) nz.push_back(k);
            nzs.push_back(std::move(nz));
        }
        const double ms = timeit([&] {
            for (size_t i = 0; i < mats.size(); i++) sparse(mats[i].wt, mats[i].K, mats[i].N, x.data(), nzs[i], y.data());
        });
        printf("{\"kind\":\"sparse\",\"sparsity\":%.2f,\"ms\":%.1f,\"gain\":%.2f}\n", s, ms, dense_ms / ms);
    }
    return 0;
}
